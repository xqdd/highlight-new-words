import type { StatusSummary, SyncAllProgress, SyncAllResult } from '@/core/messaging/protocol';

/**
 * popup “全部同步”的后台受理 + 轮询流程（与 App.vue 解耦，便于单测 mock 消息与定时器）。
 *
 * 开启欧路等慢来源时整轮同步可能要 1 分多钟，popup 不再阻塞等待 `syncAll`：
 * 1. 发 `syncAll({background:true})`，后台立即受理（accepted=true），同步在 SW 中继续，popup 关闭不影响；
 * 2. 每 `intervalMs` 拉一次 `getStatusSummary`，`syncAll.running=false` 且出现本轮（finishedAt ≥ startedAt）的 result 即完成；
 * 3. 完成后交给 onDone 展示 `syncAll.result.message`；popup 关闭（stop）时停止轮询。
 *
 * 重新打开 popup 时用 resume(summary)：后台仍在进行中则接着轮询，界面保持“同步中”。
 */
export interface SyncAllRunnerDeps {
  /** 发 syncAll 消息（App 中为 sendToBackground('syncAll', ...)） */
  requestSyncAll: (data: { background: boolean }) => Promise<SyncAllResult>;
  /** 拉总状态（App 中为 sendToBackground('getStatusSummary', {})） */
  getSummary: () => Promise<StatusSummary>;
  /** 每次拿到新总状态时回写界面 */
  onSummary: (summary: StatusSummary) => void;
  /** 进行中状态变化（控制“全部同步”按钮转圈 / 禁用） */
  onRunningChange: (running: boolean) => void;
  /** 本轮结束：message 为后台汇总文案；ok=false 时表示有失败项或流程异常 */
  onDone: (message: string, ok: boolean) => void;
  /** 后台不支持 syncAll（旧版本）或受理失败时的兜底：逐个同步 */
  fallback: () => Promise<void>;
  intervalMs?: number;
}

export interface SyncAllRunner {
  /** 点击“全部同步” */
  start: () => Promise<void>;
  /** popup 打开时根据总状态恢复：后台正在同步则继续轮询 */
  resume: (summary: StatusSummary | undefined) => void;
  /** popup 关闭时停止轮询（后台同步不受影响） */
  stop: () => void;
}

/** 轮询期间 SW 被回收（syncAll 字段丢失）或连续拉取失败时的上限，避免无限轮询 */
const MAX_POLL_ERRORS = 3;

export function createSyncAllRunner(deps: SyncAllRunnerDeps): SyncAllRunner {
  const intervalMs = deps.intervalMs ?? 1500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  /** 当前跟踪的这一轮的开始时间（后台的 startedAt），用于区分“上一轮的旧结果” */
  let trackingStartedAt: number | undefined;
  let pollErrors = 0;

  function finish(message: string, ok: boolean) {
    clearTimeout(timer);
    timer = undefined;
    trackingStartedAt = undefined;
    deps.onRunningChange(false);
    deps.onDone(message, ok);
  }

  function schedulePoll() {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => void poll(), intervalMs);
  }

  async function poll() {
    if (stopped || trackingStartedAt === undefined) return;
    let summary: StatusSummary;
    try {
      summary = await deps.getSummary();
    } catch {
      if (++pollErrors >= MAX_POLL_ERRORS) finish('无法读取同步进度，请稍后在同步状态中查看', false);
      else schedulePoll();
      return;
    }
    if (stopped) return;
    pollErrors = 0;
    deps.onSummary(summary);
    const p = summary.syncAll;
    if (p?.running) return schedulePoll();
    if (p?.result && p.result.finishedAt >= trackingStartedAt) return finish(p.result.message, p.result.ok);
    // 没有 running 也没有本轮结果：SW 在同步途中被回收，结果已丢失，各项状态以总状态里的 busy/error 为准
    finish('后台同步已结束，各项结果见同步状态', true);
  }

  function track(startedAt: number) {
    trackingStartedAt = startedAt;
    pollErrors = 0;
    schedulePoll();
  }

  return {
    async start() {
      if (trackingStartedAt !== undefined) return;
      deps.onRunningChange(true);
      let res: SyncAllResult | undefined;
      try {
        res = await deps.requestSyncAll({ background: true });
      } catch {
        res = undefined;
      }
      if (stopped) return;
      if (!res) {
        // 旧后台不认识 syncAll：逐个同步（各自 toast）
        try {
          await deps.fallback();
        } finally {
          deps.onRunningChange(false);
        }
        return;
      }
      deps.onSummary(res.summary);
      // 旧后台忽略 background 参数、直接返回完整结果
      if (!res.accepted) return finish(res.message || (res.ok ? '已全部同步' : '部分同步失败'), res.ok);
      track(res.startedAt ?? res.summary.syncAll?.startedAt ?? Date.now());
    },
    resume(summary) {
      const p = summary?.syncAll;
      if (!p?.running || trackingStartedAt !== undefined || stopped) return;
      deps.onRunningChange(true);
      track(p.startedAt);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** 重新打开 popup 时展示“上次全部同步结果”的时效：超过该时间的旧结果不再提示 */
export const RECENT_SYNC_ALL_MS = 10 * 60_000;

/**
 * popup 打开时“全部同步”的展示状态：running → 进行中；结果在 RECENT_SYNC_ALL_MS 内 → 上次结果文案；否则不提示。
 * 上次结果的文案带相对时间，避免用户误以为是刚刚发生的。
 */
export function syncAllOpenState(
  progress: SyncAllProgress | undefined,
  now: number,
): { kind: 'running' } | { kind: 'recent'; ok: boolean; text: string } | undefined {
  if (!progress) return undefined;
  if (progress.running) return { kind: 'running' };
  const r = progress.result;
  if (!r || now - r.finishedAt > RECENT_SYNC_ALL_MS) return undefined;
  const mins = Math.floor((now - r.finishedAt) / 60_000);
  const ago = mins < 1 ? '刚刚' : `${mins} 分钟前`;
  return { kind: 'recent', ok: r.ok, text: `上次全部同步（${ago}）：${r.message}` };
}

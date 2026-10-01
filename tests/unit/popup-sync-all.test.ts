import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusSummary, SyncAllProgress, SyncAllResult } from '@/core/messaging/protocol';
import { RECENT_SYNC_ALL_MS, createSyncAllRunner, syncAllOpenState } from '@/entrypoints/popup/syncAllRunner';

function summary(syncAll?: SyncAllProgress): StatusSummary {
  return {
    level: 'ok',
    text: '',
    lastSyncAt: 0,
    items: [],
    permissions: { allSites: true } as StatusSummary['permissions'],
    ...(syncAll ? { syncAll } : {}),
  };
}

function accepted(startedAt: number): SyncAllResult {
  return { summary: summary({ running: true, startedAt }), sources: [], ok: true, complete: false, accepted: true, startedAt, message: '已开始同步' };
}

/** 构造 runner，消息全部 mock，记录界面回调 */
function setup(over: { requestSyncAll?: () => Promise<SyncAllResult>; summaries?: (StatusSummary | Error)[] } = {}) {
  const summaries = [...(over.summaries ?? [])];
  const events: string[] = [];
  const deps = {
    requestSyncAll: vi.fn(over.requestSyncAll ?? (async () => accepted(1000))),
    getSummary: vi.fn(async () => {
      const next = summaries.shift();
      if (!next) throw new Error('没有更多 summary');
      if (next instanceof Error) throw next;
      return next;
    }),
    onSummary: vi.fn(),
    onRunningChange: vi.fn((on: boolean) => events.push(on ? 'running' : 'idle')),
    onDone: vi.fn((msg: string, ok: boolean) => events.push(`done:${ok}:${msg}`)),
    fallback: vi.fn(async () => {
      events.push('fallback');
    }),
    intervalMs: 1500,
  };
  return { runner: createSyncAllRunner(deps), deps, events };
}

describe('popup 全部同步：后台受理 → 轮询 → 完成', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('受理后不阻塞，按间隔轮询 running，完成时 toast 后台汇总文案', async () => {
    const { runner, deps, events } = setup({
      summaries: [
        summary({ running: true, startedAt: 1000 }),
        summary({ running: true, startedAt: 1000 }),
        summary({ running: false, startedAt: 1000, result: { ok: true, complete: true, message: '已同步：欧路、WebDAV', finishedAt: 90_000 } }),
      ],
    });
    await runner.start();
    expect(deps.requestSyncAll).toHaveBeenCalledWith({ background: true });
    // 受理后立即返回，此时尚未完成、也未拉取状态
    expect(deps.onDone).not.toHaveBeenCalled();
    expect(deps.getSummary).not.toHaveBeenCalled();
    expect(events).toEqual(['running']);

    await vi.advanceTimersByTimeAsync(1500);
    expect(deps.getSummary).toHaveBeenCalledTimes(1);
    expect(deps.onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(deps.getSummary).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(deps.getSummary).toHaveBeenCalledTimes(3);
    expect(events).toEqual(['running', 'idle', 'done:true:已同步：欧路、WebDAV']);
    // 每次轮询结果都回写界面（受理 1 次 + 轮询 3 次）
    expect(deps.onSummary).toHaveBeenCalledTimes(4);
    // 完成后不再轮询
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.getSummary).toHaveBeenCalledTimes(3);
  });

  it('上一轮的旧结果不会被当成本轮完成', async () => {
    const { runner, deps } = setup({
      requestSyncAll: async () => accepted(5000),
      summaries: [
        // 后台刚受理但 summary 已经来自 running 被清掉之后：只看到上一轮（finishedAt < startedAt）的结果 → 视作 SW 丢失结果
        summary({ running: false, startedAt: 100, result: { ok: false, message: '旧结果', finishedAt: 200 } }),
      ],
    });
    await runner.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(deps.onDone).toHaveBeenCalledWith('后台同步已结束，各项结果见同步状态', true);
  });

  it('popup 关闭（stop）后停止轮询', async () => {
    const { runner, deps } = setup({ summaries: [summary({ running: true, startedAt: 1000 })] });
    await runner.start();
    runner.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.getSummary).not.toHaveBeenCalled();
    expect(deps.onDone).not.toHaveBeenCalled();
  });

  it('重新打开时后台仍在进行：resume 接着轮询直到完成', async () => {
    const { runner, deps, events } = setup({
      summaries: [summary({ running: false, startedAt: 1000, result: { ok: false, message: '失败：有道（登录已过期）', finishedAt: 2000 } })],
    });
    runner.resume(summary({ running: true, startedAt: 1000 }));
    expect(events).toEqual(['running']);
    await vi.advanceTimersByTimeAsync(1500);
    expect(events).toEqual(['running', 'idle', 'done:false:失败：有道（登录已过期）']);
    expect(deps.requestSyncAll).not.toHaveBeenCalled();
  });

  it('旧后台直接返回完整结果（无 accepted）时立即完成', async () => {
    const { runner, deps } = setup({
      requestSyncAll: async () => ({ summary: summary(), sources: [], ok: true, message: '已同步：浏览器账号同步' }),
    });
    await runner.start();
    expect(deps.onDone).toHaveBeenCalledWith('已同步：浏览器账号同步', true);
    expect(deps.getSummary).not.toHaveBeenCalled();
  });

  it('后台不支持 syncAll 时逐个同步兜底', async () => {
    const { runner, events } = setup({ requestSyncAll: async () => Promise.reject(new Error('unknown message')) });
    await runner.start();
    expect(events).toEqual(['running', 'fallback', 'idle']);
  });

  it('连续拉取失败 3 次后结束轮询并提示', async () => {
    const { runner, deps } = setup({ summaries: [new Error('x'), new Error('x'), new Error('x')] });
    await runner.start();
    await vi.advanceTimersByTimeAsync(1500 * 3);
    expect(deps.onDone).toHaveBeenCalledWith('无法读取同步进度，请稍后在同步状态中查看', false);
  });
});

describe('popup 打开时的全部同步状态', () => {
  const now = 10_000_000;
  it('进行中 / 近期结果 / 过期结果 / 无记录', () => {
    expect(syncAllOpenState({ running: true, startedAt: now - 5000 }, now)).toEqual({ kind: 'running' });
    expect(syncAllOpenState({ running: false, startedAt: 0, result: { ok: true, message: '已同步：欧路', finishedAt: now - 3 * 60_000 } }, now)).toEqual({
      kind: 'recent',
      ok: true,
      text: '上次全部同步（3 分钟前）：已同步：欧路',
    });
    expect(syncAllOpenState({ running: false, startedAt: 0, result: { ok: true, message: 'x', finishedAt: now - 20_000 } }, now)).toMatchObject({ text: '上次全部同步（刚刚）：x' });
    expect(syncAllOpenState({ running: false, startedAt: 0, result: { ok: true, message: 'x', finishedAt: now - RECENT_SYNC_ALL_MS - 1 } }, now)).toBeUndefined();
    expect(syncAllOpenState(undefined, now)).toBeUndefined();
  });
});

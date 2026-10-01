/**
 * 字幕数据（悬浮球面板的上一句/下一句、从此句播放）：
 *
 * YouTube 字幕接口 `/api/timedtext` 需要 PO Token（pot），直接用 `captionTracks[].baseUrl` 拉取只得到空响应。
 * 这里不注入 MAIN world 脚本，而是在内容脚本里用 PerformanceObserver 观察页面的资源请求，
 * 拿到播放器自己发出的、带 pot 的 timedtext URL，再在内容脚本中按 json3 格式重新请求一次（同源，带 cookie）。
 * PerformanceObserver 不受资源计时缓冲区已满的影响（YouTube 页面的缓冲区早已写满，getEntriesByType 读不到）。
 *
 * 拿不到数据（用户没开字幕、接口变化、请求失败）时，面板退回到 DOM 字幕历史（见 CaptionHistory），只能看当前句和已播过的句子。
 */

/** 一条字幕（时间单位 ms） */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** 解析后的字幕轨 */
export interface CaptionTrack {
  videoId: string;
  lang: string;
  /** 自动生成字幕（ASR）：没有标点，按行作为“句子” */
  asr: boolean;
  /** 面板按句浏览的单位：人工字幕按句末标点合并相邻字幕，自动字幕为单行 */
  sentences: Cue[];
}

/** 规范化后的 timedtext 请求 */
export interface TimedtextRequest {
  url: string;
  videoId: string;
  lang: string;
  asr: boolean;
}

/**
 * 把播放器的 timedtext URL 规范化为可重新请求的 json3 URL。
 * - 只接受英文轨（lang=en*）：面板只对英文单词查词
 * - 去掉 tlang（用户在播放器里选了“自动翻译”时，原文仍是英文轨）
 * 不是 timedtext 请求或不是英文轨时返回 null。
 */
export function normalizeTimedtextUrl(raw: string, base = 'https://www.youtube.com/'): TimedtextRequest | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (!u.pathname.endsWith('/api/timedtext')) return null;
  const videoId = u.searchParams.get('v') ?? '';
  const lang = u.searchParams.get('lang') ?? '';
  if (!videoId || !/^en\b/i.test(lang)) return null;
  u.searchParams.delete('tlang');
  u.searchParams.set('fmt', 'json3');
  return { url: u.toString(), videoId, lang, asr: u.searchParams.get('kind') === 'asr' };
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: Array<{ utf8?: string }>;
}

/**
 * 解析 json3：每个带文本的 event 是一条字幕。
 * - 人工字幕：segs 拼接，换行改为空格
 * - 自动字幕：segs 是逐词片段；aAppend 事件只是换行符，跳过；每条的结束时间取下一条的开始（原始 dDurationMs 覆盖到行被替换为止）
 */
export function parseJson3(data: unknown, asr: boolean): Cue[] {
  const events = (data as { events?: Json3Event[] } | null)?.events;
  if (!Array.isArray(events)) return [];
  const cues: Cue[] = [];
  for (const e of events) {
    if (!e.segs || e.aAppend) continue;
    const text = e.segs
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const start = e.tStartMs ?? 0;
    cues.push({ start, end: start + (e.dDurationMs ?? 0), text });
  }
  cues.sort((a, b) => a.start - b.start);
  if (asr) for (let i = 0; i < cues.length - 1; i++) cues[i]!.end = Math.min(cues[i]!.end, cues[i + 1]!.start);
  return cues;
}

/** 句末：. ! ? … 后可跟引号/括号 */
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
/** 一句最多合并的字幕条数与字符数（避免没有标点的长段落合成一大块） */
const MAX_CUES_PER_SENTENCE = 3;
const MAX_SENTENCE_CHARS = 180;
/** 相邻两条间隔超过此值（ms）视为新句子 */
const MAX_GAP = 2500;

/** 字幕条合并为句：人工字幕按句末标点合并（最多 3 条），自动字幕每行一句 */
export function buildSentences(cues: Cue[], asr: boolean): Cue[] {
  if (asr) return cues.map((c) => ({ ...c }));
  const out: Cue[] = [];
  let cur: Cue | null = null;
  let count = 0;
  for (const c of cues) {
    if (cur && (c.start - cur.end > MAX_GAP || count >= MAX_CUES_PER_SENTENCE || cur.text.length + c.text.length > MAX_SENTENCE_CHARS)) {
      out.push(cur);
      cur = null;
    }
    if (!cur) {
      cur = { ...c };
      count = 1;
    } else {
      cur.text = `${cur.text} ${c.text}`;
      cur.end = Math.max(cur.end, c.end);
      count++;
    }
    if (SENTENCE_END.test(c.text)) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 时间点 t 对应的句子下标：最后一个开始时间 ≤ t 的句子（字幕间隙中取刚播完的那句）；t 早于第一句时为 0；没有句子为 -1。
 */
export function sentenceIndexAt(sentences: Cue[], t: number): number {
  if (sentences.length === 0) return -1;
  let lo = 0;
  let hi = sentences.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sentences[mid]!.start <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * timedtext 数据源：观察播放器的字幕请求，按视频缓存最近一次请求的英文轨。
 * 用户切换字幕轨（人工 ↔ 自动、换语言）时，播放器会重新请求，这里跟着换成最新的英文轨。
 */
export class TimedtextSource {
  private observer: PerformanceObserver | null = null;
  /** videoId -> 最近的请求 */
  private readonly latest = new Map<string, TimedtextRequest>();
  /** url -> 解析结果（请求中为 Promise） */
  private readonly cache = new Map<string, Promise<CaptionTrack | null>>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchJson: (url: string) => Promise<unknown> = defaultFetchJson,
  ) {}

  /** 开始观察（buffered 读取已有记录，缓冲区已满时也能收到之后的新请求） */
  start(): void {
    if (this.observer || typeof PerformanceObserver === 'undefined') return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.offer(e.name);
      });
      this.observer.observe({ type: 'resource', buffered: true });
    } catch {
      this.observer = null;
    }
  }

  /** 记录一个资源 URL（非英文 timedtext 请求会被忽略）；测试与其他来源也可直接调用 */
  offer(rawUrl: string): void {
    const req = normalizeTimedtextUrl(rawUrl, this.baseUrl);
    if (req) this.latest.set(req.videoId, req);
  }

  /** 是否已观察到该视频的英文字幕请求 */
  has(videoId: string): boolean {
    return this.latest.has(videoId);
  }

  /** 取该视频最近一次英文字幕轨的数据；没有请求记录或请求失败为 null */
  async get(videoId: string): Promise<CaptionTrack | null> {
    const req = this.latest.get(videoId);
    if (!req) return null;
    let p = this.cache.get(req.url);
    if (!p) {
      p = this.load(req);
      this.cache.set(req.url, p);
      // 失败的不缓存，下次打开面板重试
      void p.then((t) => {
        if (!t) this.cache.delete(req.url);
      });
    }
    return p;
  }

  private async load(req: TimedtextRequest): Promise<CaptionTrack | null> {
    try {
      const cues = parseJson3(await this.fetchJson(req.url), req.asr);
      if (cues.length === 0) return null;
      return { videoId: req.videoId, lang: req.lang, asr: req.asr, sentences: buildSentences(cues, req.asr) };
    } catch {
      return null;
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  // 同源请求（页面所在的 www/m.youtube.com），带 cookie；响应为空（pot 失效）时 json() 抛错，按失败处理
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`timedtext ${res.status}`);
  return res.json();
}

/**
 * DOM 字幕历史（没有 timedtext 数据时的退路）：按出现顺序记录主播放器显示过的字幕文本与当时的播放时间。
 * - 人工字幕整窗替换：每条新文本追加一条
 * - 自动字幕逐词追加：新文本以上一条开头（同一行在变长）时替换上一条
 */
export class CaptionHistory {
  private items: Cue[] = [];
  private videoId = '';
  private static readonly MAX = 300;

  /** 记录当前显示的字幕文本（空文本忽略） */
  record(videoId: string, text: string, timeMs: number): void {
    const t = text.replace(/\s+/g, ' ').trim();
    if (videoId !== this.videoId) {
      this.items = [];
      this.videoId = videoId;
    }
    if (!t) return;
    const last = this.items[this.items.length - 1];
    if (last && last.text === t) return;
    if (last && t.startsWith(last.text)) {
      last.text = t;
      last.end = timeMs;
      return;
    }
    // 拖动进度条回退后再次出现的旧字幕：按时间插入，避免历史乱序
    if (last && timeMs < last.start) {
      const dup = this.items.find((c) => c.text === t);
      if (dup) return;
      this.items.push({ start: timeMs, end: timeMs, text: t });
      this.items.sort((a, b) => a.start - b.start);
    } else {
      this.items.push({ start: timeMs, end: timeMs, text: t });
    }
    if (this.items.length > CaptionHistory.MAX) this.items.splice(0, this.items.length - CaptionHistory.MAX);
  }

  /** 该视频的历史（按时间排序的副本） */
  list(videoId: string): Cue[] {
    return videoId === this.videoId ? this.items.map((c) => ({ ...c })) : [];
  }
}

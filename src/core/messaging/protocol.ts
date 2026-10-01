import type { BookId } from '../settings/schema';
import type { SourceBookState } from '../wordbook/types';
import type {
  BackendSyncStatus,
  BackupExport,
  BackupImportMode,
  BackupImportPreview,
  BackupImportResult,
  SyncStatus,
  WebDavTestResult,
} from '../sync/types';

/**
 * 跨上下文消息契约（类型即文档）。
 *
 * - BackgroundProtocol：content/popup/options -> background（runtime.sendMessage）
 * - ContentProtocol：popup/background -> 某个标签页的内容脚本（tabs.sendMessage）
 *
 * 设置、本地导入词书等变更不走消息：扩展页面直接写 storage，其他上下文通过 storage.onChanged 感知。
 * 需要网络（来源同步/删除）或跨数据协调（熟词 + 删除来源词）的操作走 background 消息。
 * 新增消息：在对应 Protocol 接口加一项（参数 -> 返回值），并在接收方 handlers 中实现，TS 会强制补齐。
 */

/** 单本来源词书的同步结果 */
export interface SourceSyncResult {
  bookId: BookId;
  ok: boolean;
  /** 给用户看的提示文案（沿用旧版文案） */
  message: string;
  count?: number;
  /** 请求成功但远端为空（ok=true，本地缓存未被覆盖；background 第 2 轮新增） */
  empty?: boolean;
}

/** 单本来源词书的删词结果 */
export interface SourceDeleteReport {
  bookId: BookId;
  /** 成功删除（远端 + 本地缓存）的词条（小写） */
  deleted: string[];
  /** 失败的词条及原因（本地缓存保留，下次同步保持一致） */
  failed: { word: string; error: string }[];
}

/** 来源删词汇总 */
export interface DeleteWordsResult {
  ok: boolean;
  message: string;
  reports: SourceDeleteReport[];
}

/** 单个写入/移除目标的执行结果（加入生词本、标记熟词写入熟词本等） */
export interface WordTargetResult {
  /** 目标 id：`local:…`、`src:…` 或 LOCAL_KNOWN_BOOK_ID */
  bookId: BookId;
  /** 目标显示名（如“有道 · 无标签”“本地熟词本”） */
  name: string;
  ok: boolean;
  /** 实际写入/移除的单词（小写） */
  words: string[];
  /** 失败或跳过原因（如“欧路 OpenAPI 只提供读取已掌握单词的接口”） */
  error?: string;
  /** true = 因能力不足被跳过（未发请求） */
  skipped?: boolean;
}

/** markKnown 结果：熟词已写入；配置了移除目标（或旧开关 deleteOnKnown）时附带删除生词本中词形的结果 */
export interface MarkKnownResult {
  ok: boolean;
  /** 写入熟词本的原形 */
  lemma: string;
  /** 从来源生词本删除的结果；未配置移除目标或没有可删除的词时为空数组 */
  deleted: SourceDeleteReport[];
  message: string;
  /** 写入各熟词本的结果（background 第 2 轮新增） */
  written?: WordTargetResult[];
  /** 从本地生词本移除的结果（本地移除可完整撤销） */
  removedLocal?: WordTargetResult[];
  /** 撤销时远端删除能否完整恢复到原生词本：false 时 message 中已说明（加回其他分组 / 无法加回的词） */
  fullyUndoable?: boolean;
  /**
   * 因“同形异义”未执行的远端删除（background 第 3 轮新增）：如标记 lie 时生词本里的 lay（也是“放置”）、标记 find 时的 found（也是“创立”）。
   * 请求未带 confirmed=true 时后台不删除这些词，卡片可展示确认后带 confirmed 再调用一次 markKnown（幂等）。
   */
  withheld?: { bookId: BookId; name: string; words: string[] }[];
}

/** addWord 结果 */
export interface AddWordResult {
  ok: boolean;
  /** 加入的原形 */
  lemma: string;
  /** 写入各生词本的结果 */
  added: WordTargetResult[];
  /** 从各熟词本移除的结果 */
  removedKnown: WordTargetResult[];
  message: string;
}

/** removeWord 结果（“移出生词本”/撤销加入） */
export interface RemoveWordResult {
  ok: boolean;
  removed: WordTargetResult[];
  message: string;
}

/** 预览中的一个目标 */
export interface WordActionPreviewItem extends WordTargetResult {
  /** 远端操作（来源词书）；删除远端单词无法完全撤销时 undoable=false */
  remote: boolean;
  undoable: boolean;
  /** words 中属于同形异义的词形（如 lie 的 lay），远端删除需要 markKnown 带 confirmed=true（background 第 3 轮新增） */
  homographs?: string[];
}

/**
 * 执行前预览（卡片据此在确认框中列出“将从哪些生词本删除哪些词”，尤其是不可恢复的远端删除）。
 * 预览只读本地缓存，不发网络请求；words 为空的目标不列出。
 */
export interface WordActionPreview {
  action: 'add' | 'known';
  lemma: string;
  /** 将写入的目标 */
  write: WordActionPreviewItem[];
  /** 将移除的目标（含各书中将被移除的词形） */
  remove: WordActionPreviewItem[];
  /** 是否包含不可完全撤销的远端删除 */
  needsConfirm: boolean;
}

/**
 * 总状态（第二阶段 background 新增）：popup 顶部状态条、options 概览共用的“一句话状态”。
 * 严重程度：error > busy > pending > never > ok > off；UI 按 level 选颜色/图标，text 直接展示。
 */
export type StatusLevel = 'error' | 'busy' | 'pending' | 'never' | 'ok' | 'off';

/** 单个同步对象的状态：同步后端（storage.sync / WebDAV）或一个启用的来源（有道 / 欧路） */
export interface StatusItem {
  /** `storage-sync` / `webdav` / `source:<providerId>` */
  id: string;
  kind: 'backend' | 'source';
  /** 显示名：“浏览器账号同步”“WebDAV”“有道”“欧路” */
  name: string;
  level: StatusLevel;
  /** 一句中文说明（如“已同步 3 本生词本”“授权失效，请重新填写 token”“写入过于频繁，10:32 自动重试”） */
  text: string;
  /** 上次成功同步时间 ms，0=从未 */
  lastSyncAt: number;
  /** 自动重试时间（退避中） */
  retryAt?: number;
  /** 选项页对应位置（hash 路由，如 `#more/sync`、`#sources`），UI 可做“去处理”链接 */
  href: string;
}

/** 权限状态：allSites=false 时内容脚本不注入、不会高亮（用户在扩展详情改成“点击时”或 Firefox 未授权） */
export interface PermissionStatus {
  allSites: boolean;
  /** 已启用 WebDAV 时该服务器是否已授权访问；未启用为 undefined */
  webdavOrigin?: boolean;
  /** 有缺失权限时的中文提示 */
  text?: string;
}

/** 升级提示：扩展从旧版本升级后由 background 写入 storage `updateNotice`，options/popup 展示简短“更新说明”后调用 dismissUpdateNotice */
export interface UpdateNotice {
  /** 升级前版本（manifest version） */
  from: string;
  to: string;
  at: number;
}

export interface StatusSummary {
  /** 全部 items 中最严重的级别；全部关闭时为 off */
  level: StatusLevel;
  /** 总述：“已全部同步”“欧路：授权失效”“正在同步…”“未开启任何同步” */
  text: string;
  /** 各 items 中最近一次成功同步时间 */
  lastSyncAt: number;
  items: StatusItem[];
  permissions: PermissionStatus;
  updateNotice?: UpdateNotice;
  /** “立即同步全部”进度（background 第二阶段新增，可选）：running=true 进行中；result 为本次 SW 生命周期内最近一次完成的结果 */
  syncAll?: SyncAllProgress;
}

/** “立即同步全部”进度 */
export interface SyncAllProgress {
  running: boolean;
  startedAt: number;
  result?: { ok: boolean; complete?: boolean; message: string; finishedAt: number };
}

/** syncAll 结果 */
export interface SyncAllResult {
  summary: StatusSummary;
  /** 来源词书逐本结果（background=true 受理时为空） */
  sources: SourceSyncResult[];
  /**
   * 汇总文案（toast 用）：“已同步：浏览器账号同步；等待同步：WebDAV（约 30 秒后自动完成）；仍在同步：欧路；失败：有道（登录已过期）”。
   * 只要有启用项就不为空字符串。
   */
  message: string;
  /** 没有失败/未完成项（等待中、进行中不算失败） */
  ok: boolean;
  /** 第二阶段新增：ok 且没有“等待同步/仍在同步”的项，即全部真正落盘；旧调用方可忽略 */
  complete?: boolean;
  /** 第二阶段新增：background=true 时为 true，表示已受理、同步在后台进行 */
  accepted?: boolean;
  startedAt?: number;
  finishedAt?: number;
}

export interface BackgroundProtocol {
  /**
   * 朗读单词（遵循 settings.tts 的 voice/rate；force=true 时忽略自动发音开关，用于卡片上的发音按钮）。
   * 返回 spoken=false 表示未朗读：reason='disabled' 自动发音关闭；'unavailable' 当前浏览器无 chrome.tts（如部分移动端），
   * 调用方可退回页面内 speechSynthesis。
   */
  tts(data: { text: string; force?: boolean }): {
    spoken: boolean;
    reason?: 'disabled' | 'unavailable' | 'error';
    /**
     * 后台没有可用朗读引擎时（无 chrome.tts 且无 speechSynthesis）返回的朗读参数（background 第 3 轮新增）：
     * sendToBackground 收到后自动在调用方上下文（内容脚本/扩展页）用 platform 的 speakText 朗读，调用方无需处理。
     */
    fallback?: { text: string; lang?: string; voiceName?: string; rate?: number };
  };

  // ---- 来源生词本 ----
  /** 刷新某来源的远端生词本列表（调用 provider.listRemoteBooks），新发现的书登记到索引（status=never），返回该来源全部书的状态 */
  refreshSourceBooks(data: { providerId: string }): SourceBookState[];
  /**
   * 同步来源词书：bookIds 指定则只同步这些书；否则同步 providerId 下（或全部启用来源下）已登记的全部书。
   * 某来源尚无登记的书时先自动 refreshSourceBooks。各书独立执行，互不影响。
   */
  syncSourceBooks(data: { bookIds?: BookId[]; providerId?: string }): SourceSyncResult[];
  /**
   * 从来源生词本删除单词（卡片“从生词本删除”）：bookIds 不传则为包含该词的全部可删除来源词书；
   * forms=true 时删除该词的屈折词形（runs/ran/running，不含 runner 等派生词，见 background/forms.ts）
   */
  deleteSourceWords(data: { word: string; bookIds?: BookId[]; forms?: boolean }): DeleteWordsResult;

  // ---- 熟词 ----
  /**
   * 标记熟词：按 settings.wordActions.knownTargets 写入熟词本（默认本地熟词本），
   * 按 knownRemoveFrom（'auto' = 各来源 deleteOnKnown）从生词本移除该词；sameLemma 开启时移除屈折词形（不含派生词）。
   * word 为页面原词（同原形开关关闭时也会移除该词形本身）。
   * 后台保护：远端删除中的同形异义词形（previewWordAction 的 homographs）只有 confirmed=true 才删除，否则放在结果的 withheld 中。
   */
  markKnown(data: { word: string; lemma: string; confirmed?: boolean }): MarkKnownResult;
  /**
   * 撤销熟词（卡片“撤销”、熟词本管理）：移出本地熟词本；10 分钟内会撤回 markKnown 的其他写入/移除：
   * 本地生词本完整恢复；来源生词本在 provider 可加词时加回（有道非默认分组只能加回默认分组，欧路 cookie 模式无法加回）。
   * restored 为加回的单词（小写）。
   */
  unmarkKnown(data: { lemma: string }): { ok: boolean; restored?: string[]; message?: string };
  /**
   * 加入生词本（卡片收藏按钮、选中文本/右键菜单）：按 settings.wordActions.addTargets 写入（本地词书直接写；
   * 来源词书调用 provider.addWords，不支持加词的跳过并说明），按 addRemoveFromKnown 从熟词本移除该词（及同原形词形）。
   * “我的生词本”（MY_WORDS_BOOK_ID）不存在时自动创建并启用。trans/phonetic 可选，写入本地词书供释义显示。
   * targets（card 第二阶段新增，可选）：卡片上临时选择的写入目标（含“撤销后重新加入”），传入时完全取代 addTargets：
   * 未知 id 与本地熟词本过滤掉；只读目标（如欧路“已掌握”）跳过并在 added 中说明；空数组或过滤后为空视为非法（ok=false，不写入、不回退默认目标）。
   */
  addWord(data: { word: string; lemma: string; trans?: string; phonetic?: string; targets?: BookId[] }): AddWordResult;
  /** 移出生词本（收藏按钮取消、撤销加入）：bookIds 不传则为 addTargets；10 分钟内撤销加入会把移出的熟词加回 */
  removeWord(data: { lemma: string; bookIds?: BookId[] }): RemoveWordResult;
  /** 执行 addWord / markKnown 前的预览（只读本地缓存），卡片在包含远端删除时据此弹确认 */
  previewWordAction(data: { action: 'add' | 'known'; word: string; lemma: string }): WordActionPreview;
  /** 单词状态：是否已在 addTargets 的某本生词本中（卡片收藏按钮状态）、是否为熟词（含来源熟词本） */
  getWordState(data: { lemma: string }): { collected: boolean; collectedIn: BookId[]; known: boolean };

  // ---- storage.sync ----
  /** 读取跨设备同步状态与用量 */
  getSyncStatus(data: Record<string, never>): SyncStatus;
  /** 立即执行一次拉取合并 + 推送（忽略防抖），返回最新状态 */
  syncNow(data: Record<string, never>): SyncStatus;

  // ---- 同步后端（background 第 3 轮新增，见 architecture.md 4.11） ----
  /** 各同步后端状态：storage.sync（同 getSyncStatus）与 WebDAV */
  getSyncBackends(data: Record<string, never>): { storageSync: SyncStatus; webdav: BackendSyncStatus };
  /**
   * 测试 WebDAV 连接（逐步：连接 → 目录（不存在则 MKCOL 创建）→ 写入权限 → 现有同步文件）。
   * 参数不传时用已保存设置；options 应在点击处理函数里先调用 platform 的 requestOriginAccess(url)（不能先 await 其他操作）。
   */
  webdavTest(data: { url?: string; username?: string; password?: string; dir?: string }): WebDavTestResult;
  /** 立即进行一轮 WebDAV 同步（GET → 合并 → PUT If-Match，冲突时重新拉取合并后重试） */
  webdavSyncNow(data: Record<string, never>): BackendSyncStatus;
  /**
   * 导出手动备份（设置、熟词含墓碑、本地词书，可选来源词书缓存）；compress=true 时 content 为 gzip 的 base64。
   * 凭据在备份里是明文：默认不含，includeCredentials=true（用户导出时确认）才写入勾选上传的凭据
   */
  exportBackup(data: { includeSourceBooks?: boolean; includeCredentials?: boolean; compress?: boolean }): BackupExport;
  /** 导入预览（只读）：content 为 JSON 文本或 .json.gz 的 base64 */
  previewBackupImport(data: { content: string; mode: BackupImportMode }): BackupImportPreview;
  /** 执行导入：merge 合并（与同步规则相同）/ overwrite 覆盖（本机多出的数据记删除墓碑） */
  importBackup(data: { content: string; mode: BackupImportMode }): BackupImportResult;

  // ---- 总状态（第二阶段 background 新增） ----
  /** 总状态：同步后端 + 启用来源 + 权限 + 升级提示（只读，不发网络请求） */
  getStatusSummary(data: Record<string, never>): StatusSummary;
  /**
   * 立即同步全部：已启用的 storage.sync、WebDAV 与全部启用来源（并行，来源内部仍串行），返回汇总。
   * background=true（第二阶段新增，可选）：立即返回已受理（accepted=true），同步在后台继续，调用方轮询 getStatusSummary 的 syncAll 字段。
   */
  syncAll(data: { background?: boolean }): SyncAllResult;
  /** 用户已看过升级说明：清除 storage `updateNotice` */
  dismissUpdateNotice(data: Record<string, never>): void;
  /**
   * 打开选项页（floatball 第 1 轮修复新增）：内容脚本不能调用 runtime.openOptionsPage，也不能直接打开扩展页面，由 background 代为打开。
   * hash 为选项页路由（如 `sync/webdav`、`#sources`，前导 # 可有可无）：不传或为空时 runtime.openOptionsPage()（复用已打开的选项页）；
   * 传入时新标签页打开 options.html#hash。打开失败时 handler 抛错，发送方收到 ok=false。
   */
  openOptions(data: { hash?: string }): void;

  /** 内容脚本上报本 frame 已高亮的不同词条（全量，非增量），用于徽章计数 */
  reportPageWords(data: { lemmas: string[] }): void;
  /** popup 查询某标签页已高亮的不同词条（合并所有 frame） */
  getTabWords(data: { tabId: number }): { lemmas: string[] };
}

export interface PageState {
  /** 当前页是否在高亮（总开关 + 站点未禁用） */
  active: boolean;
  hostname: string;
  /** 本 frame 已高亮的不同词条数 */
  matchedCount: number;
}

export interface ContentProtocol {
  /** 查询页面状态（仅顶层 frame 应答） */
  getPageState(data: Record<string, never>): PageState;
  /**
   * 后台在页面上发起的单词操作结果（第二阶段 background 新增，可选实现）：右键菜单“加入生词本/标记为熟词”执行后
   * 发给被点击的 frame，内容脚本可用卡片 toast 展示 message（未实现时后台只在徽章上闪一下 ✓/!）。
   */
  actionNotice(data: { action: 'add' | 'known'; word: string; lemma: string; ok: boolean; message: string }): void;
}

type Proto = object;
export type MsgType<P extends Proto> = Extract<keyof P, string>;
export type MsgData<P extends Proto, K extends MsgType<P>> = P[K] extends (data: infer D) => unknown ? D : never;
export type MsgReturn<P extends Proto, K extends MsgType<P>> = P[K] extends (...args: never[]) => infer R ? R : never;

/** 线上消息格式；ns 用于和其他扩展/旧消息区分 */
export interface Envelope<K extends string = string, D = unknown> {
  ns: 'hnw';
  type: K;
  data: D;
}

/** 响应格式：handler 抛错时返回 error，发送方重新抛出 */
export type ResponseEnvelope<R> = { ok: true; result: R } | { ok: false; error: string };

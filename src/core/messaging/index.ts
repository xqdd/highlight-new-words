import { browser, type Browser } from 'wxt/browser';
import type {
  BackgroundProtocol,
  ContentProtocol,
  Envelope,
  MsgData,
  MsgReturn,
  MsgType,
  ResponseEnvelope,
} from './protocol';

export * from './protocol';

type Sender = Browser.runtime.MessageSender;

/** 接收方处理器表：每个消息类型一个函数，可同步或异步返回 */
export type Handlers<P extends object> = {
  [K in MsgType<P>]: (data: MsgData<P, K>, sender: Sender) => MsgReturn<P, K> | Promise<MsgReturn<P, K>>;
};

function isEnvelope(msg: unknown): msg is Envelope {
  return !!msg && typeof msg === 'object' && (msg as Envelope).ns === 'hnw';
}

function unwrap<R>(res: ResponseEnvelope<R> | undefined): R {
  // 接收方未注册该消息类型时 res 为 undefined（如 fire-and-forget 或 frame 中无监听者）
  if (!res) return undefined as R;
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

/** 注册消息处理器（通用实现）。返回取消函数 */
function listen<P extends object>(handlers: Partial<Handlers<P>>): () => void {
  const listener = (msg: unknown, sender: Sender, sendResponse: (r: ResponseEnvelope<unknown>) => void) => {
    if (!isEnvelope(msg)) return false;
    const handler = (handlers as Record<string, ((d: unknown, s: Sender) => unknown) | undefined>)[msg.type];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(msg.data, sender))
      .then(
        (result) => sendResponse({ ok: true, result }),
        (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    // 返回 true 保持 sendResponse 通道以便异步应答
    return true;
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}

/** 发送到 background */
export async function sendToBackground<K extends MsgType<BackgroundProtocol>>(
  type: K,
  data: MsgData<BackgroundProtocol, K>,
): Promise<MsgReturn<BackgroundProtocol, K>> {
  const envelope: Envelope<K, typeof data> = { ns: 'hnw', type, data };
  return unwrap(await browser.runtime.sendMessage(envelope));
}

/** background 注册处理器（必须实现全部消息） */
export function handleBackgroundMessages(handlers: Handlers<BackgroundProtocol>): () => void {
  return listen<BackgroundProtocol>(handlers);
}

/** 发送到指定标签页的内容脚本；frameId 默认 0（顶层 frame） */
export async function sendToTab<K extends MsgType<ContentProtocol>>(
  tabId: number,
  type: K,
  data: MsgData<ContentProtocol, K>,
  frameId = 0,
): Promise<MsgReturn<ContentProtocol, K>> {
  const envelope: Envelope<K, typeof data> = { ns: 'hnw', type, data };
  return unwrap(await browser.tabs.sendMessage(tabId, envelope, { frameId }));
}

/** 内容脚本注册处理器（可只实现部分，如子 frame 不应答 getPageState） */
export function handleContentMessages(handlers: Partial<Handlers<ContentProtocol>>): () => void {
  return listen<ContentProtocol>(handlers);
}

/**
 * storage.sync 编码：JSON -> UTF-8 -> deflate-raw（CompressionStream 标准 API）-> base64。
 *
 * 选 base64 的原因：storage.sync 按“键长 + JSON 序列化值的 UTF-8 字节数”计费，
 * base64 全为 ASCII 且无需 JSON 转义，膨胀率固定 4/3；高位 Unicode 编码每字符占 2~3 字节反而更大。
 */

async function pipeBytes(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Response(bytes as BufferSource).body!.pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export function bytesToBase64(bytes: Uint8Array): string {
  // 分块调用 String.fromCharCode，避免大数组展开参数超出调用栈
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** 任意可 JSON 序列化的值 -> 压缩后的 base64 字符串 */
export async function encodeSyncValue(value: unknown): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(value));
  return bytesToBase64(await pipeBytes(raw, new CompressionStream('deflate-raw')));
}

export async function decodeSyncValue<T>(encoded: string): Promise<T> {
  const raw = await pipeBytes(base64ToBytes(encoded), new DecompressionStream('deflate-raw'));
  return JSON.parse(new TextDecoder().decode(raw)) as T;
}

/** 短哈希（SHA-256 前 12 位十六进制），用于判断段内容是否变化 */
export async function shortHash(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest).subarray(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 按固定长度切片（base64 为 ASCII，字符数即字节数） */
export function chunkString(s: string, size: number): string[] {
  if (s.length === 0) return [''];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** storage.sync 单项计费字节：键长 + JSON.stringify(value) 的 UTF-8 字节数 */
export function syncItemBytes(key: string, value: unknown): number {
  return new TextEncoder().encode(key + JSON.stringify(value)).length;
}

/**
 * 键排序后的 JSON，用于判断“内容是否相同”。
 * Chrome 的 storage 读回的对象键是按字母序排列的（底层为有序字典），与写入时的插入顺序不同，
 * 直接 JSON.stringify 比较会把相同内容判成不同，导致每次同步都重写 manifest / 本机数据。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

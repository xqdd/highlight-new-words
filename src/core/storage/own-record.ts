/**
 * 以单词、用户数据为 key 的普通对象（熟词本 words/removed、词书 UserWordMap 等）的安全读写。
 *
 * 这些对象来自 storage/JSON，是带 Object.prototype 的普通对象，key 由页面或用户数据决定：
 * - 读：`obj[word]` / `word in obj` 遇到 constructor、toString、valueOf、hasOwnProperty 会命中原型链上的函数，
 *   被误判为“已存在”；遇到 __proto__ 会取到 Object.prototype 本身
 * - 写：`obj['__proto__'] = value` 走原型 setter，改的是该对象的原型而不是写入一个词条（数据丢失，且后续查表全部错乱）
 *
 * 存储结构保持普通对象（与已存数据、chrome.storage 序列化兼容），只把按单词读写的地方换成以下函数。
 */

/** 是否为对象的自有 key（不走原型链） */
export function hasOwnKey(record: object, key: string): boolean {
  return Object.hasOwn(record, key);
}

/** 按自有属性取值；原型链上的同名属性视为不存在 */
export function getOwn<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * 写入自有数据属性。用 defineProperty 而不是赋值：key 为 __proto__ 时赋值会触发原型 setter，
 * defineProperty 总是创建/覆盖自有属性（与 JSON.parse、对象展开、Object.fromEntries 的语义一致）
 */
export function setOwn<T>(record: Record<string, T>, key: string, value: NoInfer<T>): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

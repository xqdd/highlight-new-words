/**
 * 跨上下文互斥：同一扩展的 background / 扩展页面 共享同源，用 Web Locks API（navigator.locks）串行化
 * “读-改-写” storage 的操作（如熟词本、词书索引），避免并发覆盖。
 * 内容脚本运行在页面源上，锁与扩展源不互通，因此内容脚本不应直接做读改写，而是发消息给 background。
 * 测试环境（Node）没有 navigator.locks 时退化为直接执行。
 */
export function withStorageLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks) return fn();
  return locks.request(`hnw:${name}`, fn) as Promise<T>;
}

/**
 * 跨浏览器垫片（release 模块）：Chrome / Edge / Firefox（含 Android）差异统一在此封装，
 * 业务代码不直接判断浏览器。构建期 manifest 差异见 manifest.ts（不从此处导出，避免被打进运行时代码）。
 */
export * from './capabilities';
export * from './permissions';
export * from './content-scripts';
export * from './tts';
export * from './audio';

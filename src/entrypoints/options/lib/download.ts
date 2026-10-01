import { bytesToBase64 } from '@/core/sync/codec';

/**
 * 扩展页面中触发文件下载（导出熟词本、手动备份）：Blob URL + 临时 <a download>。
 * Android Edge 上同样会进入系统下载。
 */
export function downloadFile(content: BlobPart, fileName: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 读取备份文件：gzip（魔数 1f 8b）转 base64 交给 background 解压，否则按 UTF-8 文本 */
export async function readBackupFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return bytesToBase64(bytes);
  return new TextDecoder().decode(bytes);
}

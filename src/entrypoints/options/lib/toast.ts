import { reactive } from 'vue';

/**
 * 选项页全局轻提示（snackbar）：底部弹出，可带一个操作按钮（如“撤销”）。
 * 单例即可：同一时刻只显示最新一条，新提示覆盖旧提示。
 */
export interface ToastState {
  id: number;
  message: string;
  tone: 'info' | 'error';
  action?: { label: string; run: () => unknown };
}

export const toast = reactive<{ current: ToastState | null }>({ current: null });

let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export function showToast(message: string, opts: { action?: ToastState['action']; tone?: ToastState['tone']; duration?: number } = {}) {
  clearTimeout(timer);
  const id = ++seq;
  toast.current = { id, message, tone: opts.tone ?? 'info', action: opts.action };
  // 带撤销操作的提示停留更久，给用户反应时间
  timer = setTimeout(() => {
    if (toast.current?.id === id) toast.current = null;
  }, opts.duration ?? (opts.action ? 6000 : 3000));
}

export function dismissToast() {
  clearTimeout(timer);
  toast.current = null;
}

/** 把异常转成提示文案 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

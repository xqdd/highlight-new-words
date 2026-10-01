import type { CardTrigger } from '@/core/settings/schema';
import { TAG_MARK } from '../engine/dom';
import type { CardView } from './types';

export interface TriggerOptions {
  doc: Document;
  view: CardView;
  getTrigger(): CardTrigger;
  /** 需要打开卡片时回调（入口负责组装数据并调用 view.open） */
  onOpen(mark: HTMLElement, via: 'hover' | 'tap'): void;
}

/** 悬停显示/隐藏延迟（ms），沿用旧版 100ms，防止鼠标一闪而过 */
const HOVER_SHOW_DELAY = 100;
const HOVER_HIDE_DELAY = 250;

/**
 * 卡片触发逻辑（桌面悬停 + 移动端点按）：
 * - 鼠标悬停 mark 100ms 后打开；离开 mark 与卡片 250ms 后关闭
 * - 触屏点按 mark：打开卡片，并阻止默认行为（避免点到链接内的单词直接跳转）；再次点按同一单词则放行
 * - 鼠标在卡片外按下 / 触屏在卡片外点按（click，滑动滚动不会触发）/ Esc 关闭
 * - 页面滚动由 CardView 自己处理（浮层跟随单词、单词离开视口关闭；手机底部卡片保持打开）
 * 返回解绑函数。
 */
export function bindCardTrigger(opts: TriggerOptions): () => void {
  const { doc, view } = opts;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  /** 最近一次 pointerdown 的指针类型，用于在 click 中区分触屏与鼠标 */
  let lastPointerType = 'mouse';

  const markOf = (e: Event): HTMLElement | null => {
    const t = e.target;
    return t instanceof Element ? t.closest<HTMLElement>(TAG_MARK) : null;
  };
  const hoverEnabled = () => opts.getTrigger() !== 'click';

  const onPointerOver = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || !hoverEnabled()) return;
    const mark = markOf(e);
    if (mark) {
      clearTimeout(hideTimer);
      if (view.anchor === mark && view.isOpen) return;
      clearTimeout(showTimer);
      showTimer = setTimeout(() => opts.onOpen(mark, 'hover'), HOVER_SHOW_DELAY);
    } else if (view.contains(e)) {
      clearTimeout(hideTimer);
    } else {
      clearTimeout(showTimer);
      if (view.isOpen) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => view.close(), HOVER_HIDE_DELAY);
      }
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    lastPointerType = e.pointerType || 'mouse';
    // 触屏的按下可能是滚动手势的开始，留到 click 再判断是否关闭
    if (lastPointerType === 'touch') return;
    if (view.isOpen && !view.contains(e) && !markOf(e)) view.close();
  };

  const onClick = (e: MouseEvent) => {
    if (view.contains(e)) return;
    const mark = markOf(e);
    if (!mark) {
      // 触屏点按卡片外部：关闭（不阻止页面默认行为）
      if (view.isOpen && lastPointerType === 'touch') view.close();
      return;
    }
    const isTouch = lastPointerType !== 'mouse';
    const trigger = opts.getTrigger();
    if (!isTouch && trigger === 'hover') return;
    // 已为该单词打开卡片时再次点按：放行默认行为（如链接跳转）
    if (view.isOpen && view.anchor === mark) return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(showTimer);
    opts.onOpen(mark, 'tap');
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && view.isOpen) view.close();
  };

  // capture 阶段监听：页面阻止冒泡也能收到
  doc.addEventListener('pointerover', onPointerOver, true);
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey, true);
  return () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    doc.removeEventListener('pointerover', onPointerOver, true);
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKey, true);
  };
}

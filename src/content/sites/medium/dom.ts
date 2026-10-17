/** Medium 响应正文用 pre 保留换行，不能因此当作代码；仅匹配实际响应卡片结构。 */
export function isMediumResponseText(el: Element): boolean {
  if (el.tagName !== 'PRE' || !/(^|\.)medium\.com$/i.test(el.ownerDocument.location.hostname)) return false;
  const card = el.parentElement?.parentElement;
  // 文档根不是响应卡片，不能借用页面另一处评论的按钮放行普通 pre。
  if (!card || card.matches('html,body')) return false;
  // 实际卡片仅有当前正文这一个 pre；共享正文容器不能借用另一张卡片的语义标记。
  const texts = card.querySelectorAll('pre');
  return texts.length === 1 && texts[0] === el && !!el.querySelector('div') && !el.querySelector('code')
    && !!card.querySelector('button[aria-label="Response options"]')
    && !!card.querySelector('[data-dd-action-name*="respond_sidebar"]');
}

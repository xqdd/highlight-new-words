/**
 * 卡片的极简 DOM 构建工具：全部用 createElement / textContent / setAttribute 生成节点，
 * 不拼接 HTML 字符串（不使用 innerHTML，避免 AMO 审核的 UNSAFE_VAR_ASSIGNMENT 警告，也杜绝转义遗漏）。
 */

/** 属性值：false/undefined/null 表示不设置；true 表示布尔属性（值为空串） */
type AttrValue = string | number | boolean | undefined | null;
export type Child = Node | string | false | null | undefined;

/**
 * 创建 HTML 元素。attrs 中：
 * - `class` 直接作为 className
 * - `on<事件>` 作为事件监听（如 onclick）
 * - 其余写成 attribute（dataset 用 `data-xxx` 键名）
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, AttrValue | ((e: Event) => void)> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children.flat());
  return el;
}

/** 追加子节点：字符串作为文本节点，假值跳过 */
export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === false || c === null || c === undefined || c === '') continue;
    parent.appendChild(typeof c === 'string' ? (parent.ownerDocument ?? (parent as Document)).createTextNode(c) : c);
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 图标定义：路径 d 列表 + 描边宽度；统一 24x24 viewBox、currentColor 描边 */
interface IconDef {
  paths: string[];
  width?: number;
}

const ICONS = {
  speak: { paths: ['M11 5 6 9H2v6h4l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M19 5a10 10 0 0 1 0 14'] },
  close: { paths: ['M6 6l12 12M18 6 6 18'] },
  check: { paths: ['M5 12.5l4.5 4.5L19 7.5'], width: 2.4 },
  bookmark: { paths: ['M6 3.5h12v17l-6-4.2-6 4.2z'] },
  bookmarkAdd: { paths: ['M6 3.5h12v17l-6-4.2-6 4.2z', 'M12 7.5v6M9 10.5h6'] },
  remove: { paths: ['M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13'] },
  caret: { paths: ['M6 9l6 6 6-6'], width: 2.2 },
  info: { paths: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5M12 8h.01'] },
} satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;

/** 创建 SVG 图标（aria-hidden，颜色跟随文字色） */
export function icon(doc: Document, name: IconName): SVGSVGElement {
  const def: IconDef = ICONS[name];
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(def.width ?? 2));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of def.paths) {
    const p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

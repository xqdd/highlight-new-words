/** 悬浮球与页内面板的图标（24x24 描边，currentColor），用 createElementNS 生成，不用 innerHTML */
const SVG_NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  /** 悬浮球标志：带高亮底的 “A” + 小译注 */
  logo: ['M4 19 9.5 5h1L16 19', 'M6.3 14h7.4', 'M15.5 5.5h5', 'M18 3.5v2'],
  pick: ['M9 11.5V5.8a1.6 1.6 0 0 1 3.2 0v5', 'M12.2 10.2V9a1.6 1.6 0 0 1 3.2 0v2', 'M15.4 11V10a1.6 1.6 0 0 1 3.1.2v4.3c0 3.4-2.3 6-5.6 6h-.8c-2 0-3.2-.8-4.4-2.3l-2.8-3.6a1.6 1.6 0 0 1 2.4-2.1L9 14'],
  captions: ['M3.5 5.5h17v13h-17z', 'M7 11.5h3.5M12.5 11.5H17M7 15h7M16 15h1'],
  list: ['M8.5 6.5H20M8.5 12H20M8.5 17.5H20', 'M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01'],
  settings: ['M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z', 'M19.4 13.5l1.6 1.2-1.8 3.2-1.9-.7a7.5 7.5 0 0 1-1.8 1l-.3 2h-3.6l-.3-2a7.5 7.5 0 0 1-1.8-1l-1.9.7-1.8-3.2 1.6-1.2a7 7 0 0 1 0-2.9L3 9.3l1.8-3.2 1.9.7a7.5 7.5 0 0 1 1.8-1l.3-2h3.6l.3 2a7.5 7.5 0 0 1 1.8 1l1.9-.7L21 9.3l-1.6 1.2a7 7 0 0 1 0 3z'],
  close: ['M6 6l12 12M18 6 6 18'],
  sync: ['M20 11a8 8 0 0 0-14.3-4.6L4 8', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.3 4.6L20 16', 'M20 20v-4h-4'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  hide: ['M3 3l18 18', 'M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.5 9.5 6-.5.8-1.5 2.1-3 3.4', 'M6.5 7.6C4.6 8.9 3.3 10.7 2.5 12c1 1.5 4.5 6 9.5 6 1.5 0 2.9-.4 4.1-1'],
  prev: ['M15 6l-6 6 6 6'],
  next: ['M9 6l6 6-6 6'],
  play: ['M8 5.5v13l10.5-6.5z'],
  menu: ['M4 7h16M4 12h16M4 17h16'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
} satisfies Record<string, string[]>;

export type FloatIcon = keyof typeof PATHS;

export function svgIcon(doc: Document, name: FloatIcon, size = 22): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', name === 'play' ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'logo' ? '2.2' : '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[name]) {
    const p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

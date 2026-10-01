/**
 * 动词短释义 v 的格式约束与人工覆盖表解析（build-data.mjs 与 tests/unit/data.test.ts 共用，保证构建检查与单测断言同一规则）。
 */

/** v 必须精炼完整：1–6 字，且不含“…”/“...”残缺框式（在上盖…的邮戳、确定…年代） */
export function isCleanVerbShort(v) {
  return v.length >= 1 && v.length <= 6 && !v.includes('…') && !/\.{2,}/.test(v);
}

/**
 * 解析 verb-overrides.tsv：单词<TAB>动词短释义；'-' 表示不提供 v（冷僻义宁可留空，行内回退到 s），解析为 ''。
 * 格式不合格（缺列、超过 6 字、含“…”）直接抛错，构建失败
 */
export function parseVerbOverrides(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [w, v] = line.split('\t').map((x) => x.trim());
    if (!w || v === undefined || (v !== '-' && !isCleanVerbShort(v))) throw new Error(`verb-overrides.tsv: ${line} 的动词释义缺失、超过 6 字或含“…”（置空请写 -）`);
    map.set(w, v === '-' ? '' : v);
  }
  return map;
}

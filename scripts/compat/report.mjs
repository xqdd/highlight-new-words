#!/usr/bin/env node
/**
 * 汇总 run.mjs 的结果，生成中文 Markdown 报告与问题清单。
 *
 * 用法：node scripts/compat/report.mjs [--out /tmp/gauntlet/compat] [--report REPORT.md] [--issues issues.md]
 *   读取 <out>/results/<site>-<viewport>.json（live 站点）与 off-* 开头的离线快照结果，
 *   写出 <out>/REPORT.md（按站点对比 + 与 Relingo 的胜负）和 <out>/issues.md（超阈值项，按根因模块初步归类）。
 *   报告中的“结论/分析”段落由测试员在生成后补写到 <out>/REPORT.notes.md，本脚本会原样插入到摘要之后。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[++i];
const OUT = path.resolve(args.out ?? '/tmp/gauntlet/compat');
const RESULTS = path.join(OUT, 'results');
const REPORT = path.join(OUT, args.report ?? 'REPORT.md');
const ISSUES = path.join(OUT, args.issues ?? 'issues.md');
const NOTES = path.join(OUT, 'REPORT.notes.md');

// 与 run.mjs 的 THRESHOLDS 保持一致
const T = { lcpRatio: 0.05, lcpMs: 100, extLongTaskMs: 80, clsDelta: 0.01 };
/** 胜负判定的容差：差异小于容差记为持平，避免噪声左右胜负 */
const TOL = { cpu: 15, lt: 10, cls: 0.005, lcp: 100, heap: 1, firstMark: 200 };

/**
 * 按原始 runs 重新计算 LCP 与 CLS 判定（结果文件可能由旧版 run.mjs 写出）：
 * LCP 剔除导航未完成的异常样本；CLS 在 baseline 多次极差超过阈值（页面自身双峰抖动）时用最小值对最小值，否则用中位数。
 */
function recomputeCls(e) {
  // LCP：DOMContentLoaded 在测量结束时仍未触发（dcl=0）的运行是网络卡住的异常样本（BBC 偶发，LCP 被拖到 3s+），
  // 有至少 2 次正常样本时剔除后再取中位数
  const lcpOf = (c) => {
    const runs = (e.runs?.[c] ?? []).filter((r) => r?.settle?.lcp != null);
    const okRuns = runs.filter((r) => r.settle.dcl);
    const use = okRuns.length >= 2 ? okRuns : runs;
    // 有 TTFB 时用“渲染 LCP”= LCP − TTFB，剔除服务器响应时间的抖动（HN 首字节 1–8s 不等），扩展只能影响首字节之后的部分
    const net = use.every((r) => r.settle.ttfb != null);
    const v = use.map((r) => r.settle.lcp - (net ? r.settle.ttfb : 0)).sort((a, b) => a - b);
    return { lcp: v.length ? v[Math.floor(v.length / 2)] : null, excluded: runs.length - use.length, net };
  };
  const bl = lcpOf('baseline');
  if (bl.lcp != null && e.summary.baseline) {
    e.summary.baseline.lcp = bl.lcp;
    for (const c of Object.keys(e.compare ?? {})) {
      const x = lcpOf(c), j = e.compare[c].judge;
      if (x.lcp == null || !j || !e.summary[c]) continue;
      e.summary[c].lcp = x.lcp;
      j.lcpExcluded = x.excluded + bl.excluded;
      j.lcpNet = x.net && bl.net;
      j.lcpDelta = x.lcp - bl.lcp;
      j.lcpLimit = Math.round(Math.max(bl.lcp * T.lcpRatio, T.lcpMs));
      j.lcpPass = j.lcpDelta < j.lcpLimit;
    }
  }
  const clsOf = (c) => (e.runs?.[c] ?? []).filter((r) => r?.settle).map((r) => r.settle.cls ?? 0);
  const b = clsOf('baseline');
  if (!b.length) return;
  const noisy = Math.max(...b) - Math.min(...b) > T.clsDelta;
  for (const c of Object.keys(e.compare ?? {})) {
    const x = clsOf(c), j = e.compare[c].judge;
    if (!x.length || !j || !e.summary[c]) continue;
    j.clsNoisy = noisy;
    j.clsDelta = +(noisy ? Math.min(...x) - Math.min(...b) : e.summary[c].cls - e.summary.baseline.cls).toFixed(4);
    j.clsPass = j.clsDelta <= T.clsDelta;
  }
}

const entries = fs.readdirSync(RESULTS).filter((f) => /-(mobile|desktop)\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8'))).filter((e) => e.summary);
entries.forEach(recomputeCls);
const sitesOrder = JSON.parse(fs.readFileSync(new URL('./sites.json', import.meta.url), 'utf8')).sites.map((s) => s.id);
entries.sort((a, b) => sitesOrder.indexOf(a.site) - sitesOrder.indexOf(b.site) || (a.vp === 'mobile' ? -1 : 1));
const live = entries.filter((e) => !e.site.startsWith('off-'));
const offline = entries.filter((e) => e.site.startsWith('off-'));

const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? '–' : typeof v === 'number' ? (d ? v.toFixed(d) : String(Math.round(v))) : String(v));
const sign = (v, d = 0) => (v == null ? '–' : (v > 0 ? '+' : '') + fmt(v, d));
const mark = (pass) => (pass == null ? '' : pass ? '' : ' ❌');
const vpName = { mobile: '手机 390', desktop: '桌面 1280' };
const rel = (p) => (p ? `[${path.basename(p)}](${p})` : '–');

/** 是否被拦截/不可用（任何一组 3 次全部被验证页拦截，或 baseline 无数据） */
function blockedInfo(e) {
  const b = e.summary.baseline;
  if (!b) return '无 baseline 数据（导航失败）';
  const blocked = Object.entries(e.summary).filter(([, s]) => s && s.blocked >= s.runs).map(([c]) => c);
  if (blocked.length) return `验证页拦截：${blocked.join('、')}`;
  return null;
}

/** 单站单尺寸：ours / ours-after 的阈值失败项 */
function failuresOf(e) {
  const out = [];
  for (const cfg of ['ours', 'ours-after']) {
    const j = e.compare?.[cfg]?.judge;
    const s = e.summary[cfg];
    if (!j || !s) continue;
    if (j.lcpPass === false) out.push({ cfg, kind: 'lcp', text: `LCP 增量 ${j.lcpDelta}ms > 阈值 ${j.lcpLimit}ms` });
    if (!j.longTaskPass) out.push({ cfg, kind: 'longtask', text: `扩展归因长任务中位最长 ${j.maxExtLongTask}ms > 80ms（3 次中最坏 ${j.worstExtLongTask}ms）` });
    if (j.clsPass === false) out.push({ cfg, kind: 'cls', text: `CLS 增量 ${j.clsDelta} > 0.01` });
    if (s.extErrors) out.push({ cfg, kind: 'error', text: `本扩展控制台错误 ${s.extErrors} 条：${s.extErrorSamples.map((x) => x.text.slice(0, 120)).join(' / ')}` });
    if (s.violations) out.push({ cfg, kind: 'forbid', text: `禁标区域高亮 ${s.violations} 处：${s.violationSamples.map((v) => `${v.selector}×${v.count}（${v.samples.join('; ')}）`).join(' ')}` });
    if (s.typeTest && (s.typeTest.marksInside || !s.typeTest.textKept)) out.push({ cfg, kind: 'editable', text: `可编辑区输入测试失败：内部标记 ${s.typeTest.marksInside}，文本完整 ${s.typeTest.textKept}` });
    if (s.editableMarks) out.push({ cfg, kind: 'editable', text: `可编辑区内出现 ${s.editableMarks} 个标记` });
    const lay = e.compare[cfg]?.layout;
    if (lay && lay.unexplained >= 5) out.push({ cfg, kind: 'layout', text: `无生词元素位移/变形 ${lay.unexplained} 个（推移 ${lay.pushed}，横向 ${lay.horizontal}）` });
    if (s.overflow) out.push({ cfg, kind: 'overflow', text: `受限容器被撑出溢出 ${s.overflow} 处：${s.overflowSamples.map((o) => `${o.word}@${o.container} ${o.scrollW}>${o.clientW}`).join('; ')}` });
    if (s.infinite && e.summary.baseline?.infinite) {
      const bi = e.summary.baseline.infinite;
      if (s.infinite.fps != null && bi.fps != null && s.infinite.fps < bi.fps - 5) out.push({ cfg, kind: 'scroll', text: `持续滚动帧率 ${s.infinite.fps} 低于 baseline ${bi.fps}` });
    }
    if (s.spa && s.spa.okRuns && !s.spa.marks) out.push({ cfg, kind: 'spa', text: `SPA 路由切换（${s.spa.label}）后没有补标` });
  }
  return out;
}

/** 与 Relingo 的逐项胜负（小者为优），返回 { ours: n, relingo: n, tie: n, items } */
function versus(e, cfg) {
  const a = e.summary[cfg], r = e.summary.relingo, ja = e.compare?.[cfg]?.judge, jr = e.compare?.relingo?.judge;
  if (!a || !r || !ja || !jr) return null;
  const items = [];
  const cmp = (name, x, y, tol) => {
    if (x == null || y == null) return;
    const w = Math.abs(x - y) <= tol ? 'tie' : x < y ? 'ours' : 'relingo';
    items.push({ name, ours: x, relingo: y, w });
  };
  cmp('扩展 CPU（加载+滚 3 屏）', (a.cpuLoad ?? 0) + (a.cpuScroll3 ?? 0), (r.cpuLoad ?? 0) + (r.cpuScroll3 ?? 0), TOL.cpu);
  cmp('扩展长任务最长', ja.maxExtLongTask ?? 0, jr.maxExtLongTask ?? 0, TOL.lt);
  cmp('CLS 增量', Math.max(0, ja.clsDelta ?? 0), Math.max(0, jr.clsDelta ?? 0), TOL.cls);
  cmp('LCP 增量', Math.max(0, ja.lcpDelta ?? 0), Math.max(0, jr.lcpDelta ?? 0), TOL.lcp);
  cmp('JS 堆增量', Math.max(0, ja.heapDeltaMB ?? 0), Math.max(0, jr.heapDeltaMB ?? 0), TOL.heap);
  if (a.firstMark != null && r.firstMark != null) cmp('首次高亮', a.firstMark, r.firstMark, TOL.firstMark);
  if (a.infinite && r.infinite) cmp('持续滚动扩展 CPU', a.cpuInfinite ?? 0, r.cpuInfinite ?? 0, TOL.cpu * 4);
  cmp('本扩展报错', a.extErrors ?? 0, r.extErrors ?? 0, 0);
  const n = (w) => items.filter((i) => i.w === w).length;
  return { ours: n('ours'), relingo: n('relingo'), tie: n('tie'), items };
}

const lines = [];
const P = (s = '') => lines.push(s);
const now = new Date().toISOString().replace('T', ' ').slice(0, 16);

P('# 常用网站兼容性与性能测试报告');
P();
P('[TOC]');
P();
P(`> 生成时间 ${now}（UTC），由 [report.mjs](/home/cuishuqiang/me/personal/highlight_new_words/scripts/compat/report.mjs) 根据 \`${RESULTS}\` 生成。原始数据为每个“站点×尺寸”一个 JSON，截图与热力图在 \`${path.join(OUT, 'shots')}\`。`);
P();

// ---------- 一、总体结论 ----------
const tally = { 'ours': { ours: 0, relingo: 0, tie: 0 }, 'ours-after': { ours: 0, relingo: 0, tie: 0 } };
const siteWins = { 'ours': { ours: 0, relingo: 0, tie: 0 }, 'ours-after': { ours: 0, relingo: 0, tie: 0 } };
const vsRows = [];
for (const e of live) {
  for (const cfg of ['ours', 'ours-after']) {
    const v = versus(e, cfg);
    if (!v) continue;
    for (const k of ['ours', 'relingo', 'tie']) tally[cfg][k] += v[k];
    const w = v.ours > v.relingo ? 'ours' : v.ours < v.relingo ? 'relingo' : 'tie';
    siteWins[cfg][w]++;
    if (cfg === 'ours-after') vsRows.push({ e, v, w });
  }
}
const passCount = (cfg) => {
  let total = 0, pass = 0;
  for (const e of live) {
    if (!e.compare?.[cfg]?.judge || blockedInfo(e)) continue;
    total++;
    if (!failuresOf(e).some((f) => f.cfg === cfg)) pass++;
  }
  return { total, pass };
};
P('## 一、总体结论');
P();
const pc = passCount('ours'), pca = passCount('ours-after');
P(`- 阈值通过率（站点×尺寸，排除被拦截的组合）：默认设置 **${pc.pass}/${pc.total}**，开启“词后”行内译文 **${pca.pass}/${pca.total}**。`);
P(`- 与 Relingo 逐项对比（每个站点×尺寸比较 CPU、长任务、CLS、LCP、堆、首次高亮、报错等，差异在容差内记平）：`);
P(`  - 默认设置 vs Relingo：单项 **${tally.ours.ours} 胜 / ${tally.ours.relingo} 负 / ${tally.ours.tie} 平**；按站点×尺寸计 **${siteWins.ours.ours} 胜 / ${siteWins.ours.relingo} 负 / ${siteWins.ours.tie} 平**。`);
P(`  - “词后”译文 vs Relingo（右侧注解，同类可比）：单项 **${tally['ours-after'].ours} 胜 / ${tally['ours-after'].relingo} 负 / ${tally['ours-after'].tie} 平**；按站点×尺寸计 **${siteWins['ours-after'].ours} 胜 / ${siteWins['ours-after'].relingo} 负 / ${siteWins['ours-after'].tie} 平**。`);
const winSum = siteWins['ours-after'].ours + siteWins.ours.ours, loseSum = siteWins['ours-after'].relingo + siteWins.ours.relingo;
const overall = winSum > loseSum ? '**我们胜**' : winSum < loseSum ? '**Relingo 胜**' : '**持平**';
P(`  - 总体：${overall}。`);
P();
if (fs.existsSync(NOTES)) { P(fs.readFileSync(NOTES, 'utf8').trim()); P(); }

// ---------- 二、方法 ----------
const sample = live[0];
P('## 二、测试环境与方法');
P();
P(`- 工具链：xvfb + Patchright 有头 Chromium，两种尺寸串行执行（手机 390x844 DPR2 触屏 Android Edge UA；桌面 1280x800）。方法细节见 [PLAN.md](/tmp/gauntlet/compat/PLAN.md) 与 [scripts/compat/README.md](/home/cuishuqiang/me/personal/highlight_new_words/scripts/compat/README.md)。`);
P(`- 四组：baseline（不加载扩展）、ours（默认设置：cet6、行内译文关闭、触屏显示悬浮球）、ours-after（默认 + “词后”行内译文）、relingo（v3.30.1 免费账号，B2 级，右侧注解）。`);
P(`- 每组先预热 1 次，正式测量 ${sample?.repeat ?? 3} 次（各组轮流交替），数值取中位数；报错、禁标违规、溢出取 ${sample?.repeat ?? 3} 次中的最坏值。像素差和热力图用第 1 轮截图，噪声参照为 baseline 第 2 轮。`);
P('- LCP 口径：结果中有 TTFB 时用“渲染 LCP”（LCP − TTFB，剔除服务器首字节抖动，扩展只能影响首字节之后的部分），并剔除测量结束时 DOMContentLoaded 仍未触发的卡死样本；CLS 在 baseline 自身多次抖动超过 0.01 时改用最小值对最小值。');
P('- 阈值：LCP 增量 < max(5%, 100ms)；扩展归因长任务最长 ≤ 80ms；CLS 增量 ≤ 0.01；禁标/可编辑区 0 违规；本扩展 error 为 0。');
P('- 表中“CPU”为 CPU profile（0.5ms 采样）中调用栈含该扩展脚本的时间，分加载阶段与滚动 3 屏阶段；“堆Δ”为 GC 后 JSHeapUsedSize 相对 baseline 的增量（content script 与页面同 isolate）。');
P();

// ---------- 三、总览 ----------
P('## 三、总览');
P();
for (const vp of ['desktop', 'mobile']) {
  P(`### 3.${vp === 'desktop' ? 1 : 2} ${vpName[vp]}`);
  P();
  P('| 站点 | baseline LCP | ours LCPΔ | ours CLSΔ | ours 长任务 | ours CPU | ours 堆Δ | ours 标记 | 词后 CLSΔ | 词后推移元素/最大px | Relingo LCPΔ | Relingo CLSΔ | Relingo 长任务 | Relingo CPU | Relingo 堆Δ | Relingo 标记 |');
  P('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const e of live.filter((x) => x.vp === vp)) {
    const b = e.summary.baseline, o = e.summary.ours, a = e.summary['ours-after'], r = e.summary.relingo;
    const jo = e.compare?.ours?.judge, ja = e.compare?.['ours-after']?.judge, jr = e.compare?.relingo?.judge;
    const bl = blockedInfo(e);
    const la = e.compare?.['ours-after']?.layout;
    P(`| [${e.site}](#${e.site}) ${bl ? `⚠️${bl}` : ''} | ${fmt(b?.lcp)} | ${sign(jo?.lcpDelta)}${mark(jo?.lcpPass)} | ${sign(jo?.clsDelta, 3)}${jo?.clsNoisy ? '*' : ''}${mark(jo?.clsPass)} | ${fmt(jo?.maxExtLongTask)}${mark(jo?.longTaskPass)} | ${fmt(o?.cpuLoad)}+${fmt(o?.cpuScroll3)} | ${sign(jo?.heapDeltaMB, 1)} | ${fmt(o?.marks)} | ${sign(ja?.clsDelta, 3)}${ja?.clsNoisy ? '*' : ''}${mark(ja?.clsPass)} | ${la ? `${la.pushed}/${la.maxPushPx}` : '–'} | ${sign(jr?.lcpDelta)} | ${sign(jr?.clsDelta, 3)}${jr?.clsNoisy ? '*' : ''} | ${fmt(jr?.maxExtLongTask)} | ${fmt(r?.cpuLoad)}+${fmt(r?.cpuScroll3)} | ${sign(jr?.heapDeltaMB, 1)} | ${fmt(r?.marks)} |`);
  }
  P();
}
P('❌ 表示超出阈值。LCP/CLS/长任务均为 3 次中位数（CLS 带 * 表示 baseline 自身 CLS 抖动超过 0.01，改用最小值对最小值）；“CPU”格式为 加载阶段+滚 3 屏阶段（ms）。');
P();

// ---------- 四、与 Relingo 对比 ----------
P('## 四、与 Relingo 的逐站胜负（“词后”译文组）');
P();
P('| 站点 | 尺寸 | 胜/负/平 | 结果 | 我们落后的项目 |');
P('| --- | --- | --- | --- | --- |');
for (const { e, v, w } of vsRows) {
  const lost = v.items.filter((i) => i.w === 'relingo').map((i) => `${i.name} ${fmt(i.ours, i.name.includes('CLS') ? 3 : 0)} vs ${fmt(i.relingo, i.name.includes('CLS') ? 3 : 0)}`).join('；') || '–';
  P(`| ${e.site} | ${vpName[e.vp]} | ${v.ours}/${v.relingo}/${v.tie} | ${w === 'ours' ? '我们胜' : w === 'relingo' ? 'Relingo 胜' : '持平'} | ${lost} |`);
}
P();

// ---------- 五、站点详情 ----------
P('## 五、站点详情');
P();
const bySite = new Map();
for (const e of live) bySite.set(e.site, [...(bySite.get(e.site) ?? []), e]);
let idx = 0;
for (const [site, list] of bySite) {
  idx++;
  P(`### 5.${idx} ${site}`);
  P();
  P(`<a id="${site}"></a>${list[0].name}：<${list[0].url}>`);
  P();
  for (const e of list) {
    const bl = blockedInfo(e);
    P(`**${vpName[e.vp]}**${bl ? `（⚠️ ${bl}）` : ''}`);
    P();
    P('| 指标 | baseline | ours | ours-after | relingo |');
    P('| --- | --- | --- | --- | --- |');
    const S = (c) => e.summary[c] ?? {};
    const J = (c) => e.compare?.[c]?.judge ?? {};
    const row = (name, f) => P(`| ${name} | ${['baseline', 'ours', 'ours-after', 'relingo'].map((c) => (e.summary[c] ? f(c) : '–')).join(' | ')} |`);
    row('LCP ms（Δ）', (c) => `${fmt(S(c).lcp)}${c === 'baseline' ? '' : `（${sign(J(c).lcpDelta)}${mark(J(c).lcpPass)}）`}`);
    row('CLS（Δ）', (c) => `${fmt(S(c).cls, 3)}${c === 'baseline' ? '' : `（${sign(J(c).clsDelta, 3)}${mark(J(c).clsPass)}）`}`);
    row('TBT ms', (c) => fmt(S(c).tbt));
    row('脚本 ms / 布局 ms', (c) => `${fmt(S(c).scriptMs)} / ${fmt(S(c).layoutMs)}`);
    row('JS 堆 MB', (c) => fmt(S(c).heapMB, 1));
    row('扩展 CPU ms（加载/滚 3 屏）', (c) => (c === 'baseline' ? '–' : `${fmt(S(c).cpuLoad)} / ${fmt(S(c).cpuScroll3)}`));
    row('扩展长任务（个数/中位最长/最坏）', (c) => (c === 'baseline' ? '–' : `${fmt(S(c).extLongTasks)} / ${fmt(S(c).maxExtLongTask)}${mark(J(c).longTaskPass)} / ${fmt(S(c).worstExtLongTask)}`));
    row('标记数（视口内 / 滚 3 屏后视口内）', (c) => (c === 'baseline' ? '–' : `${fmt(S(c).marks)}（${fmt(S(c).marksInView)} / ${fmt(S(c).scroll3InView)}）`));
    row('首次高亮 ms', (c) => (c === 'baseline' ? '–' : fmt(S(c).firstMark)));
    row('扩展报错 / 页面报错', (c) => (c === 'baseline' ? `– / ${fmt(S(c).pageErrors)}` : `${fmt(S(c).extErrors)} / ${fmt(S(c).pageErrors)}`));
    row('禁标违规 / 行高膨胀 / 容器溢出', (c) => (c === 'baseline' ? '–' : `${fmt(S(c).violations)} / ${fmt(S(c).inflated)} / ${fmt(S(c).overflow)}`));
    row('布局：自身变化/推移/无因/横向（最大推移px）', (c) => { const l = e.compare?.[c]?.layout; return c === 'baseline' || !l ? '–' : `${l.markSelf}/${l.pushed}/${l.unexplained}/${l.horizontal}（${l.maxPushPx}）`; });
    row('像素差：标记内/标记外/噪声 %（首屏）', (c) => { const p = e.compare?.[c]?.pixelTop; return c === 'baseline' || !p || p.error ? '–' : `${p.markPct}/${p.outsidePct}/${p.noisePct}`; });
    if (Object.values(e.summary).some((s) => s?.infinite)) {
      row('持续滚动：帧率/卡顿帧/TBT', (c) => { const i = S(c).infinite; return i ? `${fmt(i.fps, 1)} / ${fmt(i.jank)} / ${fmt(i.tbt)}` : '–'; });
      row('持续滚动：扩展 CPU / 堆增长 MB / 新增标记', (c) => { const i = S(c).infinite; return i ? `${c === 'baseline' ? '–' : fmt(S(c).cpuInfinite)} / ${fmt(i.heapGrowthMB, 1)} / ${fmt(i.marksAdded)}` : '–'; });
    }
    if (Object.values(e.summary).some((s) => s?.spa)) row('SPA 路由切换后标记', (c) => { const s = S(c).spa; return s ? (s.error ? `失败：${s.error.slice(0, 40)}` : `${fmt(s.marks)}（视口内 ${fmt(s.inView)}）`) : '–'; });
    if (Object.values(e.summary).some((s) => s?.typeTest)) row('输入测试：内部标记/文本完整', (c) => { const t = S(c).typeTest; return t ? `${t.marksInside} / ${t.textKept ? '是' : '否'}${t.errors.length ? '（' + t.errors[0].slice(0, 40) + '）' : ''}` : '–'; });
    if (Object.values(e.summary).some((s) => s?.editableMarks != null)) row('可编辑区内标记', (c) => fmt(S(c).editableMarks));
    P();
    const shots = ['ours', 'ours-after', 'relingo'].map((c) => {
      const r0 = e.runs?.[c]?.[0];
      const d = e.compare?.[c]?.pixelTop?.heatmap;
      return r0?.shotTop ? `${c}：${rel(r0.shotTop)}${d ? ' · 热力图 ' + rel(d) : ''}` : null;
    }).filter(Boolean);
    const b0 = e.runs?.baseline?.[0];
    if (b0?.shotTop) P(`截图：baseline ${rel(b0.shotTop)}；${shots.join('；')}`);
    const f = failuresOf(e);
    if (f.length) { P(); P(`超阈值：${f.map((x) => `\`${x.cfg}\` ${x.text}`).join('；')}`); }
    P();
  }
}

// ---------- 六、离线快照回归 ----------
if (offline.length) {
  P('## 六、离线快照回归');
  P();
  P('快照位于 [tests/fixtures/sites](/home/cuishuqiang/me/personal/highlight_new_words/tests/fixtures/sites)，由 [snapshot.mjs](/home/cuishuqiang/me/personal/highlight_new_words/scripts/compat/snapshot.mjs) 生成，回归命令 `node scripts/compat/run.mjs --offline`。');
  P();
  P('| 快照 | 尺寸 | ours 标记 | ours CLSΔ | 词后 CLSΔ | 长任务最长 | 禁标违规 | 输入测试 | 超阈值 |');
  P('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const e of offline) {
    const o = e.summary.ours, jo = e.compare?.ours?.judge, ja = e.compare?.['ours-after']?.judge;
    const f = failuresOf(e);
    P(`| ${e.site} | ${vpName[e.vp]} | ${fmt(o?.marks)} | ${sign(jo?.clsDelta, 3)}${jo?.clsNoisy ? '*' : ''} | ${sign(ja?.clsDelta, 3)}${ja?.clsNoisy ? '*' : ''} | ${fmt(Math.max(jo?.maxExtLongTask ?? 0, ja?.maxExtLongTask ?? 0))} | ${fmt(o?.violations)} | ${o?.typeTest ? `${o.typeTest.marksInside}/${o.typeTest.textKept ? '完整' : '被改'}` : '–'} | ${f.length ? f.map((x) => `${x.cfg}:${x.kind}`).join(', ') : '通过'} |`);
  }
  P();
}

// ---------- 七、超阈值清单 ----------
P(`## ${offline.length ? '七' : '六'}、超阈值与异常清单`);
P();
const allFails = [];
for (const e of [...live, ...offline]) for (const f of failuresOf(e)) allFails.push({ e, ...f });
const blockedList = live.map((e) => [e, blockedInfo(e)]).filter(([, b]) => b);
if (blockedList.length) {
  P('无法完整测试的组合：');
  P();
  for (const [e, b] of blockedList) P(`- ${e.site}（${vpName[e.vp]}）：${b}`);
  P();
}
P('| 站点 | 尺寸 | 组 | 类型 | 说明 |');
P('| --- | --- | --- | --- | --- |');
for (const f of allFails) P(`| ${f.e.site} | ${vpName[f.e.vp]} | ${f.cfg} | ${f.kind} | ${f.text.replace(/\|/g, '\\|')} |`);
P();
fs.writeFileSync(REPORT, lines.join('\n'));

// ---------- issues.md：按类型初步归类到根因模块（engine 为主），测试员复核后补充截图与验收标准 ----------
const moduleOf = (f) => {
  if (f.kind === 'error') {
    const urls = f.e.summary[f.cfg]?.extErrorSamples?.map((x) => x.url ?? '').join(' ') ?? '';
    if (/background/.test(urls)) return 'background';
    if (/floatball/.test(urls + f.text)) return 'floatball';
    return 'engine';
  }
  return 'engine';
};
const iss = ['# 兼容性问题清单（compat 自动生成，供各模块修复）', '', '[TOC]', ''];
const groups = new Map();
for (const f of allFails) {
  const m = moduleOf(f);
  groups.set(m, [...(groups.get(m) ?? []), f]);
}
let gi = 0;
const cn = ['一', '二', '三', '四', '五', '六', '七', '八'];
for (const [m, list] of groups) {
  iss.push(`## ${cn[gi++]}、${m}`, '');
  for (const f of list) iss.push(`- [${f.kind}] ${f.e.site}（${vpName[f.e.vp]}，${f.cfg}）：${f.text}。复现：\`node scripts/compat/run.mjs --sites ${f.e.site} --viewports ${f.e.vp} --configs baseline,${f.cfg}\``);
  iss.push('');
}
if (!allFails.length) iss.push('本轮没有超阈值项。');
fs.writeFileSync(ISSUES, iss.join('\n'));
console.log(`[report] ${REPORT}\n[report] ${ISSUES}\n[report] 站点×尺寸 ${live.length} 个，离线 ${offline.length} 个，超阈值 ${allFails.length} 项`);

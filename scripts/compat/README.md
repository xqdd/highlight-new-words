# 常用网站兼容性与性能测试（预研骨架）

[TOC]

## 一、现状

正式测试脚本已齐备：

| 文件 | 作用 |
| --- | --- |
| [run.mjs](run.mjs) | 四组对比测量（每组预热 1 次 + 正式 3 次取中位数，两种尺寸串行），输出 JSON、截图与热力图 |
| [report.mjs](report.mjs) | 汇总 `results/*.json`，生成 `REPORT.md`（按站点对比 + 与 Relingo 的胜负）和 `issues.md`（超阈值项） |
| [snapshot.mjs](snapshot.mjs) | 从线上页面生成 [tests/fixtures/sites](../../tests/fixtures/sites) 离线快照（精简 DOM，单个 ≤ 300KB） |
| [sites.json](sites.json) | 站点清单。`group=offline` 为快照条目，`snapshotOf` 指向对应的线上站点；`editable.html` 是手工 fixture |

## 二、用法

```bash
OUT_DIR=/tmp/gauntlet/out/compat npm run build
# 默认自动套 xvfb-run，有头 Patchright Chromium
node scripts/compat/run.mjs --sites wikipedia --viewports desktop
node scripts/compat/run.mjs --group github,news --configs baseline,ours --repeat 1
node scripts/compat/run.mjs --repeat 3 --skip-done   # 全部线上站点（约 3.5 小时），中断后可续跑
node scripts/compat/run.mjs --offline                # 快照回归，按阈值给出退出码
node scripts/compat/snapshot.mjs                     # 重新生成快照
node scripts/compat/report.mjs                       # 生成 /tmp/gauntlet/compat/REPORT.md 与 issues.md
```

参数的完整说明见 `run.mjs` 文件头。输出写到 `/tmp/gauntlet/compat/results/*.json`（截图和热力图在 `shots/`）。测试员的人工分析可写到 `/tmp/gauntlet/compat/REPORT.notes.md`，`report.mjs` 会把它插入报告摘要之后。

依赖：仓库不引入 patchright，脚本按以下顺序解析：`import('patchright')`、全局安装的 `patchright@1.63.0`、`/tmp/gauntlet/node_modules/playwright`（兜底，没有反检测能力）。

## 三、四组配置

| 组 | 说明 |
| --- | --- |
| baseline | 不加载扩展。第 2 轮截图与布局样本作为“页面自身波动”的噪声参照 |
| ours | 加载 `/tmp/gauntlet/out/compat/chrome-mv3`，扩展默认设置（cet6、行内译文关闭；触屏尺寸显示悬浮球），可用 `--settings` 覆盖 |
| ours-after | 同上，另开启“词后”行内译文 |
| relingo | 复制 `/tmp/gauntlet/bench/login/profile` 后加载 `relingo-ext`（免费账号，B2 级，右侧注解） |

各组先预热 1 次（缓存、验证页 cookie），再轮流交替正式测量 `--repeat` 次（默认 3）。数值指标取中位数，报错、禁标违规、溢出取最坏值。

## 四、阈值

| 指标 | 通过条件 |
| --- | --- |
| LCP 增量 | < max(baseline × 5%, 100ms) |
| 扩展归因长任务 | 最长 ≤ 80ms（即“50ms 级”）。长任务窗口内某扩展的 CPU 采样占比 ≥ 50% 时，归因到该扩展 |
| CLS 增量 | ≤ 0.01（≈0） |
| 禁标区域 | pre/code/textarea/input/contenteditable/[role=textbox] 以及站点自定义选择器内不能出现高亮 |
| 控制台 | 不能有归因到本扩展的 error |

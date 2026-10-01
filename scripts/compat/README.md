# 常用网站兼容性与性能测试（预研骨架）

[TOC]

## 一、现状

当前是预研骨架。正式的全站点测试要等功能开发完成后再跑。[run.mjs](run.mjs) 已在维基百科（三组对比）和 X 已登录首页（只读滚动）上验证可以跑通。Markdown 汇总脚本和 [tests/fixtures/sites](../../tests/fixtures/sites) 离线快照留到正式阶段补齐。[sites.json](sites.json) 里 `group=offline` 的条目引用的快照文件目前还没有生成。

## 二、用法

```bash
OUT_DIR=/tmp/gauntlet/out/compat npm run build
# 默认自动套 xvfb-run，有头 Patchright Chromium
node scripts/compat/run.mjs --sites wikipedia --viewports desktop
node scripts/compat/run.mjs --group github,news --configs baseline,ours
node scripts/compat/run.mjs --offline            # 快照回归，按阈值给出退出码
```

参数的完整说明见 `run.mjs` 文件头。输出写到 `/tmp/gauntlet/compat/results/*.json`（截图和热力图在 `shots/`）。

依赖：仓库不引入 patchright，脚本按以下顺序解析：`import('patchright')`、全局安装的 `patchright@1.63.0`、`/tmp/gauntlet/node_modules/playwright`（兜底，没有反检测能力）。

## 三、三组配置

| 组 | 说明 |
| --- | --- |
| baseline | 不加载扩展。完整跑两遍，第一遍作为“页面自身波动”的噪声参照 |
| ours | 加载 `/tmp/gauntlet/out/compat/chrome-mv3`，设置为 `cet6` 加“词后”行内翻译（可用 `--settings` 覆盖） |
| relingo | 复制 `/tmp/gauntlet/bench/login/profile` 后加载 `relingo-ext`（免费账号，B2 级，右侧注解） |

## 四、阈值

| 指标 | 通过条件 |
| --- | --- |
| LCP 增量 | < max(baseline × 5%, 100ms) |
| 扩展归因长任务 | 最长 ≤ 80ms（即“50ms 级”）。长任务窗口内某扩展的 CPU 采样占比 ≥ 50% 时，归因到该扩展 |
| CLS 增量 | ≤ 0.01（≈0） |
| 禁标区域 | pre/code/textarea/input/contenteditable/[role=textbox] 以及站点自定义选择器内不能出现高亮 |
| 控制台 | 不能有归因到本扩展的 error |

#!/usr/bin/env node
/**
 * 把构建产物打成 .crx，用于手机 Edge（Canary）开发者选项“Extension install by crx”侧载测试，不用于商店发布。
 *
 * 用法：npm run pack:crx            （先 build:edge，再打包 .output/edge-mv3）
 *       node scripts/pack-crx.mjs [扩展目录]
 *
 * - 签名私钥固定放在 .cache/crx-key.pem（.cache 不进 git）：首次运行时由浏览器生成，之后复用，扩展 ID 保持不变，
 *   手机上覆盖安装时能保留设置与数据。私钥丢失只会让 ID 变化，重新安装即可
 * - 用 Chromium 内核浏览器的 --pack-extension 打包（无头模式，不需要显示器）。浏览器按顺序查找：
 *   环境变量 CHROME_PATH → PATH 中的 google-chrome / chromium / microsoft-edge → Playwright 缓存里的 Chromium
 * - 产物：.output/highlight-new-words-<版本>.crx
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const extDir = path.resolve(ROOT, process.argv[2] ?? '.output/edge-mv3');
const keyPath = path.join(ROOT, '.cache/crx-key.pem');
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
const out = path.join(ROOT, `.output/highlight-new-words-${manifest.version}.crx`);

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    try {
      return execSync(`command -v ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      // 没装这个，继续找下一个
    }
  }
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort() : [];
  for (const d of dirs.reverse()) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = path.join(cache, d, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('找不到 Chromium 内核浏览器，请设置环境变量 CHROME_PATH');
}

// --pack-extension 把 crx/pem 写在扩展目录旁边（<目录>.crx、首次生成的 <目录>.pem），先复制到临时目录，避免污染 .output
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-crx-'));
const work = path.join(tmp, 'ext');
fs.cpSync(extDir, work, { recursive: true });
const args = ['--headless=new', '--no-sandbox', `--pack-extension=${work}`];
if (fs.existsSync(keyPath)) args.push(`--pack-extension-key=${keyPath}`);
const res = spawnSync(findChrome(), args, { stdio: 'inherit', timeout: 60_000 });
if (!fs.existsSync(`${work}.crx`)) {
  fs.rmSync(tmp, { recursive: true, force: true });
  throw new Error(`打包失败（退出码 ${res.status}）`);
}
if (!fs.existsSync(keyPath)) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.copyFileSync(`${work}.pem`, keyPath);
  fs.chmodSync(keyPath, 0o600);
  console.log(`已生成签名私钥 ${path.relative(ROOT, keyPath)}（勿提交、勿外传）`);
}
fs.copyFileSync(`${work}.crx`, out);
fs.chmodSync(out, 0o644);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`已打包 ${path.relative(ROOT, out)}`);

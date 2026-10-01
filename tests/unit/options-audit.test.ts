import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourceItem } from '@/background/status';
import { syncFootText } from '@/content/floatball/model';
import { INLINE_MODE_LABELS, INLINE_MODE_ORDER } from '@/core/settings/inline-translation-labels';
import type { BookRole } from '@/core/settings/schema';
import { SOURCE_NOT_CONNECTED_TEXT } from '@/core/source/connect-status';
import type { BookMeta, SourceBookState } from '@/core/wordbook/types';
import { bookSyncLine, sourceCardSummary } from '@/entrypoints/options/lib/source-card';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createDefaultSettings } from '@/core/settings/defaults';
import type { Settings } from '@/core/settings/schema';
import CredentialSyncSection from '@/entrypoints/options/sections/CredentialSyncSection.vue';
import { provideOptions } from '@/entrypoints/options/lib/context';
import { prehideNote } from '@/entrypoints/options/lib/performance';

/**
 * options 集成审核修复轮（问题来源 audit）的回归测试。
 * 组件用 @vitejs/plugin-vue 直接挂载在 jsdom 中；jsdom 不实现 <dialog>.showModal，这里补最小桩。
 */

// jsdom 缺 showModal/close：只维护 open 属性，足够驱动 BottomSheet
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
}

/** 在 options 上下文中挂载组件，返回容器与设置 ref */
function mountWithOptions(comp: unknown, settings = ref<Settings>(createDefaultSettings())) {
  const el = document.createElement('div');
  document.body.append(el);
  const Root = defineComponent({
    setup() {
      provideOptions({ settings, books: ref([]), navigate: () => {} });
      return () => h(comp as never);
    },
  });
  const app = createApp(Root);
  app.mount(el);
  return { el, settings, unmount: () => { app.unmount(); el.remove(); } };
}

const flush = async () => { await nextTick(); await nextTick(); };

describe('P1-1 凭据随同步上传：确认前不显示为打开', () => {
  function webdavToggle(el: HTMLElement) {
    return el.querySelector<HTMLInputElement>('[data-cred="webdav"] input[type=checkbox]')!;
  }
  function buttonByText(text: string) {
    return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  }

  it('打开开关 → 弹层期间 checkbox 未勾选；取消后仍未勾选且设置未变', async () => {
    const { el, settings, unmount } = mountWithOptions(CredentialSyncSection);
    const input = webdavToggle(el);
    expect(input.checked).toBe(false);
    input.click(); // 浏览器先把 checkbox 勾上再触发 change
    await flush();
    expect(document.querySelector('dialog[open]')).toBeTruthy();
    expect(input.checked).toBe(false);
    buttonByText('取消').click();
    await flush();
    expect(input.checked).toBe(false);
    expect(settings.value.credentialSync?.webdav).toBeFalsy();
    unmount();
  });

  it('点“我了解风险，打开”后才勾选并写入设置', async () => {
    const { el, settings, unmount } = mountWithOptions(CredentialSyncSection);
    const input = webdavToggle(el);
    input.click();
    await flush();
    buttonByText('我了解风险，打开').click();
    await flush();
    expect(settings.value.credentialSync?.webdav).toBe(true);
    expect(input.checked).toBe(true);
    unmount();
  });
});

describe('P1-2 来源“未连接”统一口径', () => {
  const NOW = 1_800_000_000_000;
  const srcBook = (id: string, sync: Partial<SourceBookState>, size = 0, role: BookRole = 'new') =>
    ({
      id,
      name: sync.name ?? id,
      kind: 'source',
      category: 'user',
      level: 0,
      size,
      providerId: 'youdao',
      sync: { id, providerId: 'youdao', remoteId: id, name: id, status: 'ok', lastSyncAt: 0, lastAttemptAt: 0, wordCount: size, role, ...sync },
    }) as unknown as BookMeta;
  const roleOf = (b: BookMeta) => (b.sync?.role ?? 'new') as BookRole;

  it('新装默认启用有道、从没登录：中性“未连接”，主按钮登录网页版，原因只做灰色提示', () => {
    const c = sourceCardSummary({ name: '有道词典', books: [], roleOf, listError: '未登录有道或登录已失效，请先登录有道单词本网页版', hasToken: false, now: NOW });
    expect(c).toMatchObject({ tone: 'neutral', title: SOURCE_NOT_CONNECTED_TEXT, primary: 'login', showLogin: true, hint: '没有检测到有道词典网页版的登录，请先登录有道单词本网页版' });
    // 从未登录过的新用户不提“登录已失效”
    expect(c.hint).not.toMatch(/失效/);
    expect(c.error).toBeUndefined();
    // 与后台 sourceItem（popup、悬浮球的数据源）同一文案与级别
    expect(sourceItem('youdao', '有道词典', { books: {}, providers: { youdao: { lastListAt: 1, error: 'x' } } })).toMatchObject({ level: 'never', text: SOURCE_NOT_CONNECTED_TEXT });
    expect(syncFootText({ level: 'never', text: '', items: [sourceItem('youdao', '有道词典', { books: {}, providers: {} })] })).toEqual({ level: 'off', text: '有道词典未连接' });
  });

  it('popup “去连接”按钮：未连接（muted）用中性样式，不用红色错误', () => {
    const list = readFileSync('src/entrypoints/popup/components/SyncList.vue', 'utf8');
    expect(list).toMatch(/muted: c\.status\.tone === 'muted'/);
    expect(list).toMatch(/\.btn\.fix\.muted \{ color: var\(--text\); border-color: var\(--border\); \}/);
    const app = readFileSync('src/entrypoints/popup/App.vue', 'utf8');
    expect(app).toMatch(/\.sync-muted \.btn\.fix, \.sync-ok \.btn\.fix \{ color: var\(--text\); border-color: var\(--border\); \}/);
  });

  it('登录过、后来失效才显示红色错误；欧路填了 token 不再提示登录', () => {
    const synced = srcBook('a', { lastSyncAt: NOW - 3600e3 }, 10);
    const c = sourceCardSummary({ name: '有道词典', books: [synced], roleOf, listError: '登录已失效', hasToken: false, now: NOW });
    expect(c).toMatchObject({ tone: 'error', error: '登录已失效', primary: 'sync' });
    const t = sourceCardSummary({ name: '欧路词典', books: [], roleOf, hasToken: true, now: NOW });
    expect(t).toMatchObject({ tone: 'neutral', primary: 'refresh', showLogin: false });
    expect(t.subtitle).not.toMatch(/登录/);
  });

  it('P2-3 汇总按用途分开计数：熟词本不算生词本', () => {
    const books = [srcBook('a', { lastSyncAt: NOW }, 3000), srcBook('b', { lastSyncAt: NOW }, 112), srcBook('m', { lastSyncAt: NOW }, 868, 'known')];
    expect(sourceCardSummary({ name: '欧路词典', books, roleOf, hasToken: true, now: NOW }).title).toBe('2 个生词本 · 3,112 词 · 1 个熟词本 868 词');
  });

  it('P2-4 为空的分组：显示“同步于 …”而不是“从未同步”', () => {
    expect(bookSyncLine(srcBook('e', { status: 'empty', lastAttemptAt: NOW - 10_000 }), NOW)).toBe('0 词 · 同步于 刚刚');
    expect(bookSyncLine(srcBook('n', { status: 'never' }), NOW)).toBe('0 词 · 从未同步');
  });
});

describe('P1-3 行内译文统一叫法', () => {
  it('首屏预隐藏说明引用的模式名与当前选项一致', () => {
    const note = prehideNote(createDefaultSettings());
    expect(note).toMatch(/“词后”“词上方”/);
    expect(note).not.toMatch(/词后括号/);
  });

  it('四个界面使用同一组标签，UI 字符串中不再用“释义”指代行内译文', () => {
    expect(INLINE_MODE_ORDER.map((m) => INLINE_MODE_LABELS[m])).toEqual(['关闭', '词后', '词上方', '仅悬停']);
    const files = [
      'src/entrypoints/options/pages/AppearancePage.vue',
      'src/entrypoints/options/pages/WelcomeGuide.vue',
      'src/entrypoints/popup/App.vue',
      'src/content/floatball/menu.ts',
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toMatch(/INLINE_MODE_LABELS/);
      expect(src, f).not.toMatch(/行内释义|词后释义|词上方释义|不显示释义|label: '悬停显示'|label: '词后括号'|>释义</);
    }
  });
});

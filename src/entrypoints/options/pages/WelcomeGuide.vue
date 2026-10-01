<script setup lang="ts">
import { computed, ref } from 'vue';
import { INLINE_MODE_LABELS, INLINE_MODE_ORDER, INLINE_TRANSLATION_NAME } from '@/core/settings/inline-translation-labels';
import type { InlineTranslationMode } from '@/core/settings/schema';
import AppIcon, { type IconName } from '@/ui/components/AppIcon.vue';
import SegmentedControl from '@/ui/components/SegmentedControl.vue';
import LivePreview from '../components/LivePreview.vue';
import PresetCard from '../components/PresetCard.vue';
import SiteAccessBanner from '../components/SiteAccessBanner.vue';
import { applyPreset, presetGroups } from '../lib/appearance';
import { formatCount, isBookEnabled, toggleBook } from '../lib/books';
import { useOptions } from '../lib/context';

/**
 * 首次使用引导（#welcome）：① 选词书（多选组合）→ ② 选样式（预设 + 行内译文，带实时预览）→ ③ 接入生词本 / 导入熟词。
 * 对标 Relingo 三步引导，但手机 390 宽可用（Relingo 引导页在移动端两栏不折叠、横向溢出）。
 * 每一步的修改立即保存，随时可跳过。
 */
const { settings, books, navigate } = useOptions();
const step = ref(0);
const STEPS = ['选择词书', '高亮样式', '生词本与熟词'];

const builtin = computed(() => books.value.filter((b) => b.kind === 'builtin').sort((a, b) => (a.category === b.category ? a.level - b.level : a.category.localeCompare(b.category))));
const presets = presetGroups().combos.slice(0, 8);

// 行内译文模式：与外观页、popup、悬浮球同一组短标签
const INLINE: { value: InlineTranslationMode; label: string }[] = INLINE_MODE_ORDER.map((value) => ({ value, label: INLINE_MODE_LABELS[value] }));

const NEXT_ACTIONS: { icon: IconName; title: string; desc: string; page: string; anchor?: string }[] = [
  { icon: 'cloud', title: '同步有道 / 欧路生词本', desc: '有道登录网页版、欧路填写授权 token 后一键同步，可多个生词本分别启用', page: 'sources', anchor: 'providers' },
  { icon: 'upload', title: '导入单词表', desc: 'TXT、CSV、Anki、有道 XML、欧路导出均可', page: 'sources', anchor: 'import' },
  { icon: 'known', title: '导入已掌握的词', desc: '熟词不再高亮，减少干扰', page: 'known', anchor: 'known-import' },
];

function finish(page = 'books', anchor?: string) {
  navigate(page, anchor);
}
</script>

<template>
  <div class="guide">
    <header class="head">
      <img src="/icons/48.png" alt="" width="36" height="36" />
      <div class="titles">
        <strong>欢迎使用生词高亮</strong>
        <span class="muted">三步完成设置，之后随时可以在设置页修改</span>
      </div>
      <button type="button" class="skip" @click="finish()">跳过</button>
    </header>

    <SiteAccessBanner />

    <ol class="steps" aria-label="引导进度">
      <li v-for="(s, i) in STEPS" :key="s" :class="{ on: i === step, done: i < step }" :aria-current="i === step ? 'step' : undefined">
        <span class="num"><AppIcon v-if="i < step" name="check" :size="14" /><template v-else>{{ i + 1 }}</template></span>
        <span class="label">{{ s }}</span>
      </li>
    </ol>

    <section v-if="step === 0" class="body">
      <h2>想在网页上标出哪些词？</h2>
      <p class="muted">可以多选组合，比如“六级 + 考研”。之后还能加入自己的生词本。</p>
      <div class="cards">
        <button
          v-for="b in builtin"
          :key="b.id"
          type="button"
          class="card"
          role="switch"
          :aria-checked="isBookEnabled(settings, b.id)"
          @click="toggleBook(settings, b.id)"
        >
          <span class="card-top">
            <strong>{{ b.name }}</strong>
            <span class="check"><AppIcon v-if="isBookEnabled(settings, b.id)" name="check" :size="14" /></span>
          </span>
          <span class="muted">{{ formatCount(b.size) }} 词</span>
        </button>
      </div>
    </section>

    <section v-else-if="step === 1" class="body">
      <h2>生词怎么显示？</h2>
      <div class="pv"><LivePreview :settings="settings" :books="books" /></div>
      <div class="presets" role="radiogroup" aria-label="预设配色">
        <PresetCard
          v-for="t in presets"
          :key="t.id"
          :mark="t.mark"
          :name="t.name"
          :translation="t.translation?.mode"
          :checked="settings.style.themeId === t.id"
          compact
          @click="applyPreset(settings, t.id)"
        />
      </div>
      <p class="seg-label">{{ INLINE_TRANSLATION_NAME }}<span class="muted">（在生词旁显示简短中文）</span></p>
      <SegmentedControl v-model="settings.inlineTranslation.mode" :options="INLINE" :aria-label="INLINE_TRANSLATION_NAME" />
      <button type="button" class="link" @click="finish('appearance')">更多配色与取色 →</button>
    </section>

    <section v-else class="body">
      <h2>还有你自己的生词？</h2>
      <p class="muted">可选。也可以以后在“生词本”“熟词”页面设置。</p>
      <div class="actions">
        <button v-for="a in NEXT_ACTIONS" :key="a.title" type="button" class="action" @click="finish(a.page, a.anchor)">
          <span class="a-ico"><AppIcon :name="a.icon" :size="22" /></span>
          <span class="a-text"><strong>{{ a.title }}</strong><span class="muted">{{ a.desc }}</span></span>
          <AppIcon name="chevron" :size="18" />
        </button>
      </div>
    </section>

    <footer class="foot">
      <button v-if="step > 0" type="button" class="btn" @click="step--">上一步</button>
      <span class="spacer" />
      <span v-if="step === 0" class="muted picked">已选 {{ settings.books.enabled.length }} 本</span>
      <button v-if="step < STEPS.length - 1" type="button" class="btn primary" :disabled="step === 0 && !settings.books.enabled.length" @click="step++">下一步</button>
      <button v-else type="button" class="btn primary" @click="finish()">完成</button>
    </footer>
  </div>
</template>

<style scoped>
.guide { max-width: 680px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; padding: 20px 16px calc(88px + env(safe-area-inset-bottom)); gap: 16px; }
.seg-label { margin: 4px 0 -8px; font-weight: 600; font-size: 14px; }
.seg-label .muted { font-weight: 400; font-size: 12px; }
.head { display: flex; align-items: center; gap: 12px; }
.titles { flex: 1; display: flex; flex-direction: column; line-height: 1.35; }
.titles strong { font-size: 18px; }
.skip { border: 0; background: transparent; color: var(--text-2); min-height: var(--tap); padding: 0 8px; cursor: pointer; }
.steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.steps li { display: flex; align-items: center; gap: 8px; padding-top: 10px; border-top: 3px solid var(--border); color: var(--text-2); font-size: 13px; }
.steps li.on, .steps li.done { border-color: var(--accent); color: var(--text); }
.num { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; background: var(--surface-2); flex: none; }
.on .num, .done .num { background: var(--accent); color: var(--accent-text); }
.body { display: flex; flex-direction: column; gap: 12px; }
h2 { margin: 8px 0 0; font-size: 22px; }
.body > p { margin: -6px 0 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.card { display: flex; flex-direction: column; gap: 4px; padding: 14px; border-radius: 14px; border: 1.5px solid var(--border); background: var(--surface);
  text-align: left; cursor: pointer; color: var(--text); min-height: 76px; }
.card[aria-checked='true'] { border-color: var(--accent); background: var(--accent-soft); }
.card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 16px; }
.check { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--border); display: grid; place-items: center; flex: none; }
.card[aria-checked='true'] .check { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.pv { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 4px 0; }
.presets { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.preset { display: flex; flex-direction: column; gap: 6px; padding: 6px; border-radius: 12px; border: 1.5px solid var(--border); background: var(--surface); cursor: pointer; color: var(--text); }
.preset[aria-checked='true'] { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.paper { display: grid; place-items: center; height: 42px; border-radius: 8px; background: #fff; color: #1f2328; font: 17px/1 Georgia, serif; }
.pname { font-size: 12px; color: var(--text-2); text-align: center; }
.link { align-self: flex-start; border: 0; background: transparent; color: var(--accent); font-weight: 600; cursor: pointer; min-height: var(--tap); padding: 0; }
.actions { display: flex; flex-direction: column; gap: 10px; }
.action { display: flex; align-items: center; gap: 14px; padding: 14px; border-radius: 14px; border: 1px solid var(--border); background: var(--surface);
  text-align: left; cursor: pointer; color: var(--text); }
.action:hover { border-color: var(--accent); }
.a-ico { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); flex: none; }
.a-text { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.foot { position: fixed; inset: auto 0 0 0; display: flex; align-items: center; gap: 10px; padding: 12px max(16px, calc((100vw - 680px) / 2 + 16px)) calc(12px + env(safe-area-inset-bottom));
  background: var(--surface); border-top: 1px solid var(--border); }
.foot .btn { min-width: 96px; min-height: 44px; }
.spacer { flex: 1; }
@media (max-width: 480px) {
  .presets { grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .paper { height: 38px; font-size: 15px; }
  .cards { grid-template-columns: 1fr 1fr; }
  .steps .label { font-size: 12px; }
}
</style>

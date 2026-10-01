<script setup lang="ts">
import { computed } from 'vue';
import SegmentedControl from '@/ui/components/SegmentedControl.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { isMacPlatform } from '@/content/card/trigger-config';
import { glossLook } from '@/content/sites/youtube/captions';
import {
  CAPTION_GLOSS_PRESETS,
  applyCaptionPreset,
  matchCaptionPreset,
  resolveCaptionStyle,
  type CaptionGlossStyle,
} from '@/core/theme/caption-style';
import { TRANSLATION_BRACKETS, type TranslationBracket } from '@/core/theme/themes';
import ColorRow from '../components/ColorRow.vue';
import { useOptions } from '../lib/context';

/**
 * YouTube 字幕（v9，settings.youtube，实现见 floatball 模块 sites/youtube）：
 * 字幕中标注生词、字幕中的生词译文（上方注解 / 下方注解 / 词后 / 只高亮，带字幕样式的小预览）、字幕译文样式（预设 + 自定义，
 * settings.youtube.captionStyle）、悬停字幕自动暂停（电脑，默认关）。
 * 字幕上的悬停查词遵循“查词与卡片”的打开方式；手机上通过悬浮球打开“当前字幕面板”逐词查看。
 */
const { settings, navigate } = useOptions();
const panelKey = isMacPlatform() ? '⌥L' : 'Alt+L';

const TR_MODES = [
  { value: 'above' as const, label: '上方注解', desc: '默认，译文在生词上方，字幕行不变宽；自动生成的字幕改为词后' },
  { value: 'below' as const, label: '下方注解', desc: '译文在生词下方，字幕行不变宽；自动生成的字幕改为词后' },
  { value: 'after' as const, label: '词后', desc: '译文跟在生词后面，放不下时自动改为上方' },
  { value: 'off' as const, label: '只高亮', desc: '字幕里不显示译文，查词看卡片' },
];

// ---------- 字幕译文样式 ----------
const capStyle = computed(() => resolveCaptionStyle(settings.value.youtube.captionStyle));
const capPreset = computed(() => matchCaptionPreset(settings.value.youtube.captionStyle));
function patchCap(p: Partial<CaptionGlossStyle>) {
  settings.value.youtube.captionStyle = { ...settings.value.youtube.captionStyle, ...p };
}
function pickCapPreset(id: string) {
  settings.value.youtube.captionStyle = applyCaptionPreset(settings.value.youtube.captionStyle, id);
}
const CAP_BRACKETS: { value: TranslationBracket; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'paren', label: '( )' },
  { value: 'fullwidth', label: '（ ）' },
  { value: 'square', label: '[ ]' },
  { value: 'lenticular', label: '【 】' },
];
/** 预览里注解的内联样式与文字：外观声明与内容脚本同源（glossLook），字号按比例缩放（预览字幕 15px，下限 10px） */
function glossPreview(st: CaptionGlossStyle | undefined, mode: string) {
  const r = resolveCaptionStyle(st);
  const [open, close] = TRANSLATION_BRACKETS[r.bracket];
  return { text: `${open}意外之喜${close}`, style: `${glossLook(r, mode === 'after' ? 400 : 500)};font-size:max(${r.fontScale}em,10px)` };
}
/** 预设卡片的预览按当前字幕译文模式排版（只高亮时按上方注解展示） */
const previewMode = computed(() => (settings.value.youtube.captionTranslation === 'off' ? 'above' : settings.value.youtube.captionTranslation));
const presetSamples = computed(() => CAPTION_GLOSS_PRESETS.map((p) => ({ preset: p, gloss: glossPreview(p.style, previewMode.value) })));
</script>

<template>
  <SettingsSection id="youtube" title="YouTube 字幕" description="在视频字幕中标注生词，并按下面的方式显示译文">
    <ToggleSwitch v-model="settings.youtube.captions" label="YouTube 字幕中标注生词" description="关闭后字幕保持原样，页面其他文字照常标注" />
    <template v-if="settings.youtube.captions">
      <span class="lbl">字幕中的生词译文</span>
      <div class="cap-modes" role="radiogroup" aria-label="字幕中的生词译文">
        <button
          v-for="mo in TR_MODES"
          :key="mo.value"
          type="button"
          role="radio"
          class="cap-mode"
          :aria-checked="settings.youtube.captionTranslation === mo.value"
          @click="settings.youtube.captionTranslation = mo.value"
        >
          <!-- 字幕样式小预览：近黑半透明底 + 白字，注解按当前字幕译文样式 -->
          <span class="cap" :class="mo.value" aria-hidden="true">
            <span class="line">a happy <span class="g">accident<span v-if="mo.value !== 'off'" class="gl" :style="glossPreview(settings.youtube.captionStyle, mo.value).style">{{ glossPreview(settings.youtube.captionStyle, mo.value).text }}</span></span></span>
          </span>
          <span class="cap-text"><strong>{{ mo.label }}</strong><span class="muted">{{ mo.desc }}</span></span>
        </button>
      </div>
      <template v-if="settings.youtube.captionTranslation !== 'off'">
        <span class="lbl">字幕译文样式 · {{ capPreset?.name ?? '自定义' }}</span>
        <div class="cap-gallery" role="radiogroup" aria-label="字幕译文样式预设">
          <button
            v-for="{ preset: p, gloss } in presetSamples"
            :key="p.id"
            type="button"
            role="radio"
            class="cap-preset"
            :aria-checked="capPreset?.id === p.id"
            :title="p.desc"
            @click="pickCapPreset(p.id)"
          >
            <span class="cap" :class="previewMode" aria-hidden="true">
              <span class="line">a happy <span class="g">accident<span class="gl" :style="gloss.style">{{ gloss.text }}</span></span></span>
            </span>
            <span class="cap-name">{{ p.name }}</span>
          </button>
        </div>
        <span class="lbl">括号</span>
        <SegmentedControl :model-value="capStyle.bracket" :options="CAP_BRACKETS" aria-label="字幕译文括号" @update:model-value="(v: TranslationBracket) => patchCap({ bracket: v })" />
        <span class="lbl">译文颜色</span>
        <ColorRow :model-value="capStyle.color" label="字幕译文颜色" @update:model-value="(c: string) => patchCap({ color: c })" />
        <span class="lbl">译文底色</span>
        <ColorRow
          :model-value="capStyle.background"
          label="字幕译文底色"
          empty-label="无底色（黑色描边）"
          alpha
          :default-alpha="0.86"
          @update:model-value="(c: string) => patchCap({ background: c })"
        />
        <label class="slider">
          <span>字号 {{ Math.round(capStyle.fontScale * 100) }}%</span>
          <input type="range" min="0.55" max="1" step="0.05" :value="capStyle.fontScale" @input="patchCap({ fontScale: Number(($event.target as HTMLInputElement).value) })" />
        </label>
        <ToggleSwitch :model-value="capStyle.bold" label="加粗" @update:model-value="(v: boolean) => patchCap({ bold: v })" />
        <ToggleSwitch :model-value="capStyle.italic" label="斜体" @update:model-value="(v: boolean) => patchCap({ italic: v })" />
        <p class="muted small">字号相对字幕字号，全屏时随字幕一起变大；去掉底色后用黑色描边保证在亮画面上可读。</p>
      </template>
      <ToggleSwitch
        v-model="settings.youtube.hoverPause"
        label="鼠标悬停字幕时自动暂停（电脑）"
        description="移开 0.3 秒后继续播放，只恢复由扩展暂停的视频。手机上点悬浮球即可暂停并逐词查看"
      />
      <p class="muted small">
        字幕上的悬停查词遵循<button type="button" class="inline-link" @click="navigate('appearance', 'card')">释义卡片</button>中的打开方式。电脑上按
        <kbd>{{ panelKey }}</kbd> 可打开当前字幕面板，暂停后逐词查看。
      </p>
    </template>
  </SettingsSection>
</template>

<style scoped>
.lbl { font-size: 13px; font-weight: 600; color: var(--text-2); }
.small { font-size: 12px; margin: 0; }
.cap-modes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
@media (max-width: 720px) { .cap-modes { grid-template-columns: 1fr; } }
.cap-mode { display: flex; flex-direction: column; align-items: stretch; gap: 8px; padding: 10px; border-radius: 12px; border: 1.5px solid var(--border);
  background: var(--surface); cursor: pointer; text-align: left; color: var(--text); min-height: var(--tap); }
.cap-mode[aria-checked='true'] { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.cap-text { display: flex; flex-direction: column; min-width: 0; }
.cap-text .muted { font-size: 12px; }
.cap { display: flex; align-items: flex-end; justify-content: center; height: 56px; padding: 0 6px 8px; border-radius: 8px;
  background: linear-gradient(160deg, #3b4252, #1f2430); font: 500 15px/1.2 'YouTube Noto', Roboto, Arial, sans-serif; white-space: nowrap; }
.line { background: rgba(8, 8, 8, .75); color: #fff; padding: 2px 5px; }
.g { position: relative; }
/* 注解：外观（颜色/底色/字重/描边/字号）由内联样式给出，与内容脚本同源；这里只负责按模式摆放 */
.gl { white-space: nowrap; line-height: 1.25; padding: 0 .25em; border-radius: 3px; }
.cap.above .gl { position: absolute; left: 50%; bottom: 100%; transform: translateX(-50%); margin-bottom: 1px; }
.cap.below { padding-bottom: 20px; }
.cap.below .gl { position: absolute; left: 50%; top: 100%; transform: translateX(-50%); margin-top: 1px; }
.cap.after .gl { margin-left: .18em; padding: 0 .2em; }
/* 字幕译文样式预设：小卡片网格，手机 2 列 */
.cap-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
@media (max-width: 480px) { .cap-gallery { grid-template-columns: 1fr 1fr; gap: 6px; } }
.cap-preset { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 12px; border: 1.5px solid var(--border);
  background: var(--surface); cursor: pointer; color: var(--text); min-width: 0; }
.cap-preset[aria-checked='true'] { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.cap-preset .cap { overflow: hidden; }
.cap-name { font-size: 12px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slider { display: grid; grid-template-columns: 7.5em 1fr; align-items: center; gap: 10px; min-height: var(--tap); font-size: 13px; }
.slider input { width: 100%; accent-color: var(--accent); }
kbd { font-family: inherit; font-size: 12px; padding: 0 6px; border-radius: 5px; background: var(--surface-2); border: 1px solid var(--border); border-bottom-width: 2px; }
.inline-link { border: 0; background: none; padding: 0 2px; color: var(--accent); cursor: pointer; font: inherit; text-decoration: underline; text-underline-offset: 2px; }
/* 手机：预览与文字左右排（放在 .cap 基础样式之后才能覆盖字号） */
@media (max-width: 720px) { .cap-mode { flex-direction: row; align-items: center; } .cap-mode .cap { flex: none; width: 46%; font-size: 12px; } }
@media (max-width: 480px) { .cap-preset .cap { font-size: 12px; } }
</style>

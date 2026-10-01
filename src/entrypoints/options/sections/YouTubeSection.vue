<script setup lang="ts">
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { isMacPlatform } from '@/content/card/trigger-config';
import { useOptions } from '../lib/context';

/**
 * YouTube 字幕（v9，settings.youtube，实现见 floatball 模块 sites/youtube）：
 * 字幕中标注生词、字幕中的生词译文（上方注解 / 词后 / 只高亮，带字幕样式的小预览）、悬停字幕自动暂停（电脑，默认关）。
 * 字幕上的悬停查词遵循“查词与卡片”的打开方式；手机上通过悬浮球打开“当前字幕面板”逐词查看。
 */
const { settings, navigate } = useOptions();
const panelKey = isMacPlatform() ? '⌥L' : 'Alt+L';

const TR_MODES = [
  { value: 'above' as const, label: '上方注解', desc: '默认，译文在生词上方，字幕行不变宽' },
  { value: 'below' as const, label: '下方注解', desc: '译文在生词下方，字幕行不变宽' },
  { value: 'after' as const, label: '词后', desc: '译文跟在生词后面，放不下时自动改为上方' },
  { value: 'off' as const, label: '只高亮', desc: '字幕里不显示译文，查词看卡片' },
];
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
          <!-- 字幕样式小预览：近黑半透明底 + 白字，生词与注解颜色同内容脚本（暖黄） -->
          <span class="cap" :class="mo.value" aria-hidden="true">
            <span class="line">a happy <span class="g" data-g="意外之喜">accident</span></span>
          </span>
          <span class="cap-text"><strong>{{ mo.label }}</strong><span class="muted">{{ mo.desc }}</span></span>
        </button>
      </div>
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
.g { color: #ffe08a !important; position: relative; }
.cap.above .g::after { content: attr(data-g); position: absolute; left: -4px; right: -4px; bottom: 100%; text-align: center; font-size: 10px; line-height: 1.3;
  color: #ffe08a; background: rgba(8, 8, 8, .75); border-radius: 3px 3px 0 0; }
.cap.below { padding-bottom: 20px; }
.cap.below .g::after { content: attr(data-g); position: absolute; left: -4px; right: -4px; top: 100%; text-align: center; font-size: 10px; line-height: 1.3;
  color: #ffe08a; background: rgba(8, 8, 8, .75); border-radius: 0 0 3px 3px; }
.cap.after .g::after { content: attr(data-g); font-size: .62em; margin-left: .2em; color: #ffe08a; }
kbd { font-family: inherit; font-size: 12px; padding: 0 6px; border-radius: 5px; background: var(--surface-2); border: 1px solid var(--border); border-bottom-width: 2px; }
.inline-link { border: 0; background: none; padding: 0 2px; color: var(--accent); cursor: pointer; font: inherit; text-decoration: underline; text-underline-offset: 2px; }
/* 手机：预览与文字左右排（放在 .cap 基础样式之后才能覆盖字号） */
@media (max-width: 720px) { .cap-mode { flex-direction: row; align-items: center; } .cap { flex: none; width: 46%; font-size: 12px; } }
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { InlineTranslationMode } from '@/core/settings/schema';
import { resolveCardStyle, resolveMarkStyle } from '@/core/theme/resolve';
import { CUSTOM_THEME_ID, findTheme } from '@/core/theme/themes';
import AppIcon from '@/ui/components/AppIcon.vue';
import MarkPreview from '@/ui/components/MarkPreview.vue';
import SegmentedControl from '@/ui/components/SegmentedControl.vue';
import SettingRow from '@/ui/components/SettingRow.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { HIGHLIGHT_PALETTE, MARK_KINDS, buildMark, markKind, markPrimaryColor, tintMark, type MarkKind } from '@/ui/components/palette';
import { formatHexAlpha, parseColor } from '@/ui/color';
import ColorSheet from '../components/ColorSheet.vue';
import LivePreview from '../components/LivePreview.vue';
import { applyCustomMark, applyPreset, autoAssignBookColors, presetGroups, setBookColor } from '../lib/appearance';
import { useOptions } from '../lib/context';

/**
 * 外观页：吸顶实时预览 + 预设配色 + 自定义（样式类型 × 色板/取色器）+ 按词书分色 + 行内释义样式 + 卡片。
 * 对标：不背单词“下划线颜色”预设色板（门槛低）+ Relingo 颜色规则与取色器（可精细调整）。
 */
const { settings, books } = useOptions();
const { main: mainPresets, legacy: legacyPresets } = presetGroups();

const globalMark = computed(() => resolveMarkStyle(settings.value));
const kind = computed(() => markKind(globalMark.value));
const color = computed(() => markPrimaryColor(globalMark.value));
const isUnderlineKind = computed(() => !['background', 'text'].includes(kind.value));
const withTint = computed(() => isUnderlineKind.value && !!globalMark.value.background);
const isCustom = computed(() => settings.value.style.themeId === CUSTOM_THEME_ID);
const showLegacy = ref(legacyPresets.some((t) => t.id === settings.value.style.themeId));

const setKind = (k: MarkKind) => applyCustomMark(settings.value, buildMark(k, color.value, withTint.value));
const setColor = (c: string) => applyCustomMark(settings.value, tintMark(globalMark.value, c));
const setTint = (on: boolean) => applyCustomMark(settings.value, buildMark(kind.value, color.value, on));

// ---------- 按词书分色 ----------
const enabledBooks = computed(() =>
  settings.value.books.enabled.map((id) => {
    const meta = books.value.find((b) => b.id === id);
    const o = settings.value.style.perBook[id];
    return {
      id,
      name: meta ? meta.name : id,
      mark: resolveMarkStyle(settings.value, id),
      overridden: !!o,
      presetName: o?.themeId ? findTheme(o.themeId)?.name : undefined,
    };
  }),
);

// ---------- 取色弹层：编辑目标可以是全局主色、某本词书、或高级里的某个颜色字段 ----------
interface ColorTarget {
  title: string;
  description?: string;
  alpha?: boolean;
  get: () => string;
  set: (c: string) => void;
  /** 额外操作（如“跟随全局”） */
  reset?: { label: string; run: () => void };
}
const target = ref<ColorTarget | null>(null);
const sheetOpen = computed({ get: () => !!target.value, set: (v) => !v && (target.value = null) });
const sheetColor = computed({ get: () => target.value?.get() || '#ff7008', set: (c) => target.value?.set(c) });

function editGlobalColor() {
  target.value = { title: '高亮颜色', description: '所有未单独设色的词书使用此颜色', get: () => color.value, set: setColor };
}
function editBookColor(id: string, name: string) {
  target.value = {
    title: name,
    description: '为这本词书的生词指定颜色，样式与全局一致',
    get: () => markPrimaryColor(resolveMarkStyle(settings.value, id)),
    set: (c) => setBookColor(settings.value, id, c),
    reset: { label: '跟随全局', run: () => setBookColor(settings.value, id, null) },
  };
}

/** 高级：直接编辑 custom 的单个颜色字段（带透明度）；空串表示继承页面 */
type MarkField = 'background' | 'color' | 'underlineColor';
type CardField = 'background' | 'color' | 'accent';
function editMarkField(field: MarkField, title: string) {
  target.value = {
    title,
    alpha: true,
    get: () => globalMark.value[field] || '#ff7008',
    set: (c) => applyCustomMark(settings.value, { ...globalMark.value, [field]: c }),
    reset: { label: '清除', run: () => applyCustomMark(settings.value, { ...globalMark.value, [field]: '' }) },
  };
}
function editCardField(field: CardField, title: string) {
  target.value = {
    title,
    alpha: field === 'background',
    get: () => resolveCardStyle(settings.value)[field],
    set: (c) => {
      if (!isCustom.value) applyCustomMark(settings.value, globalMark.value);
      settings.value.style.custom.card = { ...settings.value.style.custom.card, [field]: c };
    },
  };
}
const cardStyle = computed(() => resolveCardStyle(settings.value));

const swatchBg = (c: string) => (c ? c : 'transparent');
/** 色块显示为不透明主色（背景型高亮本身是半透明的，色块上看不清） */
const solid = (c: string) => parseColor(c)?.hex ?? c;

const INLINE_MODES: { value: InlineTranslationMode; label: string; desc: string }[] = [
  { value: 'off', label: '不显示', desc: '只高亮，点按或悬停查看释义' },
  { value: 'after', label: '词后括注', desc: '生词后面附简短中文释义' },
  { value: 'ruby', label: '词上方', desc: '释义以注音样式显示在生词上方' },
];
</script>

<template>
  <div class="preview-dock">
    <LivePreview :settings="settings" :books="books" />
  </div>

  <SettingsSection id="presets" title="预设配色" description="点选即生效；下面可继续微调样式与颜色">
    <div class="presets" role="radiogroup" aria-label="预设配色">
      <button
        v-for="t in mainPresets"
        :key="t.id"
        type="button"
        role="radio"
        class="preset"
        :aria-label="t.name"
        :aria-checked="settings.style.themeId === t.id"
        @click="applyPreset(settings, t.id)"
      >
        <span class="paper"><MarkPreview :mark="t.mark" word="vivid" /></span>
        <span class="pname">{{ t.name }}</span>
      </button>
      <button
        type="button"
        role="radio"
        class="preset"
        aria-label="自定义"
        :aria-checked="isCustom"
        @click="applyCustomMark(settings, globalMark)"
      >
        <span class="paper"><MarkPreview :mark="settings.style.custom.mark" word="vivid" /></span>
        <span class="pname">自定义</span>
      </button>
    </div>
    <button type="button" class="link" :aria-expanded="showLegacy" @click="showLegacy = !showLegacy">
      旧版配色（{{ legacyPresets.length }}）<AppIcon :name="showLegacy ? 'up' : 'down'" :size="16" />
    </button>
    <div v-if="showLegacy" class="presets" role="radiogroup" aria-label="旧版配色">
      <button
        v-for="t in legacyPresets"
        :key="t.id"
        type="button"
        role="radio"
        class="preset"
        :aria-label="t.name"
        :aria-checked="settings.style.themeId === t.id"
        @click="applyPreset(settings, t.id)"
      >
        <span class="paper"><MarkPreview :mark="t.mark" word="vivid" /></span>
        <span class="pname">{{ t.name }}</span>
      </button>
    </div>
  </SettingsSection>

  <SettingsSection id="custom" title="样式与颜色" description="调整后自动切换为“自定义”配色">
    <div class="kinds" role="radiogroup" aria-label="高亮样式">
      <button
        v-for="k in MARK_KINDS"
        :key="k.value"
        type="button"
        role="radio"
        class="kind"
        :aria-label="'样式：' + k.label"
        :aria-checked="kind === k.value"
        @click="setKind(k.value)"
      >
        <span class="kind-sample"><MarkPreview :mark="buildMark(k.value, color, k.value !== 'background' && k.value !== 'text' && withTint)" word="Ab" /></span>
        <span>{{ k.label }}</span>
      </button>
    </div>
    <ToggleSwitch v-if="isUnderlineKind" :model-value="withTint" label="叠加同色浅底" description="下划线 + 半透明底色，长文中更醒目" @update:model-value="setTint" />

    <div class="palette" role="radiogroup" aria-label="高亮颜色">
      <button
        v-for="c in HIGHLIGHT_PALETTE"
        :key="c.hex"
        type="button"
        role="radio"
        class="swatch"
        :style="{ '--c': c.hex }"
        :aria-checked="color === c.hex"
        :aria-label="c.name"
        :title="c.name"
        @click="setColor(c.hex)"
      >
        <AppIcon v-if="color === c.hex" name="check" :size="16" />
      </button>
      <button
        type="button"
        class="swatch more"
        :class="{ on: !HIGHLIGHT_PALETTE.some((c) => c.hex === color) }"
        :style="{ '--c': color }"
        aria-label="更多颜色"
        title="更多颜色"
        @click="editGlobalColor"
      >
        <AppIcon name="plus" :size="16" />
      </button>
    </div>

    <details class="advanced">
      <summary>高级：分别设置各颜色与透明度</summary>
      <div class="fields">
        <button type="button" class="field" @click="editMarkField('background', '高亮背景')">
          <span>高亮背景</span><i class="chip" :style="{ background: swatchBg(globalMark.background) }" :class="{ none: !globalMark.background }" />
        </button>
        <button type="button" class="field" @click="editMarkField('color', '高亮文字颜色')">
          <span>文字颜色</span><i class="chip" :style="{ background: swatchBg(globalMark.color) }" :class="{ none: !globalMark.color }" />
        </button>
        <button type="button" class="field" @click="editMarkField('underlineColor', '下划线颜色')">
          <span>下划线颜色</span><i class="chip" :style="{ background: swatchBg(globalMark.underlineColor) }" :class="{ none: !globalMark.underlineColor }" />
        </button>
        <button type="button" class="field" @click="editCardField('background', '卡片背景')">
          <span>卡片背景</span><i class="chip" :style="{ background: cardStyle.background }" />
        </button>
        <button type="button" class="field" @click="editCardField('color', '卡片文字')">
          <span>卡片文字</span><i class="chip" :style="{ background: cardStyle.color }" />
        </button>
        <button type="button" class="field" @click="editCardField('accent', '卡片强调色')">
          <span>卡片强调色</span><i class="chip" :style="{ background: cardStyle.accent }" />
        </button>
      </div>
      <p class="muted">空白斜纹表示不设置（继承网页原样式）。</p>
    </details>
  </SettingsSection>

  <SettingsSection id="per-book" title="按词书分色" description="同时启用多本词书时，用颜色区分生词来自哪本书" flush>
    <template #actions>
      <button v-if="enabledBooks.length > 1" type="button" class="btn small" @click="autoAssignBookColors(settings)">
        <AppIcon name="sparkle" :size="16" />自动分色
      </button>
    </template>
    <ul v-if="enabledBooks.length" class="books">
      <li v-for="b in enabledBooks" :key="b.id">
        <button type="button" class="book" @click="editBookColor(b.id, b.name)">
          <span class="paper small"><MarkPreview :mark="b.mark" word="word" /></span>
          <span class="bname">
            <span>{{ b.name }}</span>
            <span class="muted">{{ b.presetName ? '预设：' + b.presetName : b.overridden ? '自定义颜色' : '跟随全局' }}</span>
          </span>
          <i class="chip" :style="{ background: solid(formatHexAlpha(markPrimaryColor(b.mark), 1)) }" />
          <AppIcon name="chevron" :size="18" class="chev" />
        </button>
      </li>
    </ul>
    <p v-else class="empty muted">还没有启用词书。</p>
  </SettingsSection>

  <SettingsSection id="inline" title="行内释义" description="在生词旁直接显示简短中文释义，读长文不必逐个点开">
    <div class="modes" role="radiogroup" aria-label="行内释义样式">
      <button
        v-for="m in INLINE_MODES"
        :key="m.value"
        type="button"
        role="radio"
        class="mode"
        :aria-checked="settings.inlineTranslation.mode === m.value"
        @click="settings.inlineTranslation.mode = m.value"
      >
        <span class="mode-head">
          <span class="radio" />
          <strong>{{ m.label }}</strong>
          <span class="muted">{{ m.desc }}</span>
        </span>
        <LivePreview :settings="settings" :books="books" :mode="m.value" text="short" />
      </button>
    </div>
  </SettingsSection>

  <SettingsSection id="card" title="释义卡片">
    <SettingRow label="打开方式" description="自动：电脑上悬停、手机上点按" stack>
      <SegmentedControl
        v-model="settings.card.trigger"
        :options="[
          { value: 'auto', label: '自动' },
          { value: 'hover', label: '悬停' },
          { value: 'click', label: '点击' },
        ]"
      />
    </SettingRow>
  </SettingsSection>

  <ColorSheet v-if="target" v-model:open="sheetOpen" v-model:color="sheetColor" :title="target.title" :description="target.description" :alpha="target.alpha">
    <button
      v-if="target.reset"
      type="button"
      class="btn"
      @click="
        target.reset.run();
        target = null;
      "
    >
      {{ target.reset.label }}
    </button>
  </ColorSheet>
</template>

<style scoped>
.preview-dock { position: sticky; top: 0; z-index: 5; padding: 0 0 4px; background: var(--bg); }
@media (max-width: 899px) { .preview-dock { top: 56px; margin: 0 -12px; padding: 0 12px 6px; } .preview-dock :deep(.sample) { font-size: 16px; padding: 10px 14px; } }
@media (min-width: 900px) { .preview-dock { padding-top: 8px; margin-top: -8px; } }

.presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 10px; }
.preset { display: flex; flex-direction: column; gap: 6px; padding: 6px; border-radius: 12px; border: 1.5px solid var(--border);
  background: var(--surface); cursor: pointer; color: var(--text); }
.preset[aria-checked='true'] { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.paper { display: grid; place-items: center; height: 46px; border-radius: 8px; background: #fff; color: #1f2328;
  font: 18px/1 Georgia, 'Times New Roman', serif; border: 1px solid rgba(0, 0, 0, .06); }
.paper.small { width: 64px; height: 36px; font-size: 15px; flex: none; }
.pname { font-size: 12px; color: var(--text-2); text-align: center; }
.preset[aria-checked='true'] .pname { color: var(--text); font-weight: 650; }
@media (max-width: 480px) {
  .presets { grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .preset { padding: 4px; gap: 4px; }
  .paper { height: 38px; font-size: 15px; }
}
.link { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--text-2);
  cursor: pointer; min-height: 36px; padding: 0; font-size: 13px; }

.kinds { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
.kind { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 4px; border-radius: 12px; border: 1.5px solid var(--border);
  background: var(--surface); cursor: pointer; font-size: 12px; color: var(--text-2); min-height: var(--tap); }
.kind[aria-checked='true'] { border-color: var(--accent); color: var(--text); font-weight: 650; background: var(--accent-soft); }
.kind-sample { font: 600 17px/1.6 Georgia, serif; color: var(--text); }
@media (max-width: 560px) { .kinds { grid-template-columns: repeat(3, 1fr); } }

.palette { display: grid; grid-template-columns: repeat(13, 1fr); gap: 8px; }
.swatch { aspect-ratio: 1; min-height: 32px; border-radius: 50%; border: 0; background: var(--c); cursor: pointer; color: #fff;
  display: grid; place-items: center; position: relative; }
.swatch[aria-checked='true']::after, .swatch.more.on::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var(--c); }
.swatch.more { background: conic-gradient(#f43f5e, #f59e0b, #84cc16, #10b981, #0ea5e9, #6366f1, #d946ef, #f43f5e); }
.swatch.more.on { background: var(--c); }
@media (max-width: 560px) { .palette { grid-template-columns: repeat(7, 1fr); gap: 10px; } .swatch { min-height: 36px; } }

.advanced summary { cursor: pointer; color: var(--text-2); font-size: 13px; min-height: 36px; display: flex; align-items: center; }
.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; margin: 6px 0; }
.field { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: var(--tap); padding: 6px 10px 6px 12px;
  border-radius: 10px; border: 1px solid var(--border); background: var(--surface); cursor: pointer; color: var(--text); }
.chip { width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--border); flex: none; }
.chip.none { background: repeating-linear-gradient(45deg, transparent 0 4px, var(--border) 4px 5px) !important; }
.advanced p { margin: 4px 0 0; }

.books { list-style: none; margin: 0; padding: 0; }
.book { width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 18px; min-height: 60px; border: 0;
  border-top: 1px solid var(--border); background: transparent; cursor: pointer; text-align: left; color: var(--text); }
.book:hover { background: var(--surface-2); }
.bname { flex: 1; min-width: 0; display: flex; flex-direction: column; font-weight: 600; }
.bname > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bname .muted { font-weight: 400; font-size: 12px; }
.chev { color: var(--text-2); }
.empty { padding: 4px 18px 12px; margin: 0; }

.modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.mode { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 12px; border: 1.5px solid var(--border);
  background: var(--surface); cursor: pointer; text-align: left; color: var(--text); }
.mode[aria-checked='true'] { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.mode-head { display: grid; grid-template-columns: auto 1fr; gap: 0 8px; align-items: center; }
.mode-head .muted { grid-column: 2; font-size: 12px; }
.radio { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--border); }
.mode[aria-checked='true'] .radio { border: 5px solid var(--accent); }
.mode :deep(.sample) { font-size: 15px; padding: 8px 10px; }
@media (max-width: 720px) { .modes { grid-template-columns: 1fr; } }
.btn.small { min-height: 32px; padding: 4px 12px; font-size: 13px; }
@media (max-width: 480px) { .book { padding: 10px 14px; } .empty { padding: 4px 14px 12px; } }
</style>

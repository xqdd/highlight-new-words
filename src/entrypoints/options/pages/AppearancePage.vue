<script setup lang="ts">
import { computed, ref } from 'vue';
import type { InlineTranslationMode } from '@/core/settings/schema';
import { resolveCardStyle, resolveMarkStyle, resolveTranslationStyle } from '@/core/theme/resolve';
import { CUSTOM_THEME_ID, type MarkStyle } from '@/core/theme/themes';
import AppIcon from '@/ui/components/AppIcon.vue';
import BottomSheet from '@/ui/components/BottomSheet.vue';
import MarkPreview from '@/ui/components/MarkPreview.vue';
import SegmentedControl from '@/ui/components/SegmentedControl.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { markPrimaryColor } from '@/ui/components/palette';
import ColorRow from '../components/ColorRow.vue';
import ColorSheet from '../components/ColorSheet.vue';
import CardTriggerSection from '../sections/CardTriggerSection.vue';
import LivePreview from '../components/LivePreview.vue';
import PresetCard from '../components/PresetCard.vue';
import StyleEditor from '../components/StyleEditor.vue';
import {
  applyCustomMark,
  applyPreset,
  autoAssignBookColors,
  bookStyleMode,
  currentStyleName,
  deleteSavedStyle,
  presetGroups,
  saveStyle,
  setBookColor,
  setBookStyle,
  type BookStyleMode,
} from '../lib/appearance';
import { useOptions } from '../lib/context';
import { showToast } from '../lib/toast';

/**
 * 外观页（v5）：吸顶实时预览（真实句子 + 多本词书 + 行内译文 + 链接，亮/暗网页切换）→ 预设画廊（组合预设带缩略与说明、我的样式、
 * 单色样式、旧版配色）→ 样式编辑器（装饰线 / 文字 / 背景 / 边框四个维度，可另存为“我的样式”）→ 按词书设置（跟随全局 / 只换颜色 /
 * 独立样式）→ 行内译文（模式 + 颜色/浓淡/字号/模糊自测）→ 释义卡片（电脑端打开方式 v11、卡片颜色；标题与卡片首次提示里的“设置 › 释义卡片”一致）。
 * 对标：沉浸式翻译的译文样式列表、Relingo 的分组设置与实时预览、Burning Vocabulary 的预设色块。
 */
const { settings, books } = useOptions();
const { combos, singles, legacy } = presetGroups();

const globalMark = computed(() => resolveMarkStyle(settings.value));
const isCustom = computed(() => settings.value.style.themeId === CUSTOM_THEME_ID);
const showSingles = ref(singles.some((t) => t.id === settings.value.style.themeId));
const showLegacy = ref(legacy.some((t) => t.id === settings.value.style.themeId));
const saved = computed(() => settings.value.style.saved ?? []);

/** 编辑器修改全局样式：自动切到“自定义”（预设本身不可改，用户在预设基础上微调） */
const editorMark = computed({ get: () => globalMark.value, set: (m: MarkStyle) => applyCustomMark(settings.value, m) });

// ---------- 另存为我的样式 ----------
const saving = ref(false);
const saveName = ref('');
function startSave() {
  saveName.value = isCustom.value ? `我的样式 ${saved.value.length + 1}` : `${currentStyleName(settings.value)}（改）`;
  saving.value = true;
}
function confirmSave() {
  const name = saveName.value.trim();
  if (!name) return;
  saveStyle(settings.value, name, globalMark.value);
  saving.value = false;
  showToast(`已另存为“${name}”，在上方“我的样式”中可随时选用`);
}
function removeSaved(id: string, name: string) {
  const item = saved.value.find((s) => s.id === id);
  deleteSavedStyle(settings.value, id);
  showToast(`已删除“${name}”`, {
    action: item ? { label: '撤销', run: () => (settings.value.style.saved = [...(settings.value.style.saved ?? []), item]) } : undefined,
  });
}
const savedChecked = (mark: MarkStyle) => isCustom.value && JSON.stringify(mark) === JSON.stringify(settings.value.style.custom.mark);

// ---------- 按词书 ----------
const enabledBooks = computed(() =>
  settings.value.books.enabled.map((id) => {
    const meta = books.value.find((b) => b.id === id);
    return { id, name: meta ? meta.name : id, mark: resolveMarkStyle(settings.value, id), mode: bookStyleMode(settings.value, id) };
  }),
);
const MODE_LABEL: Record<BookStyleMode, string> = { follow: '跟随全局', tint: '只换颜色', own: '独立样式' };
const bookEdit = ref<{ id: string; name: string } | null>(null);
const bookSheetOpen = computed({ get: () => !!bookEdit.value, set: (v) => !v && (bookEdit.value = null) });
const editingMode = computed(() => (bookEdit.value ? bookStyleMode(settings.value, bookEdit.value.id) : 'follow'));
const editingMark = computed({
  get: () => (bookEdit.value ? resolveMarkStyle(settings.value, bookEdit.value.id) : globalMark.value),
  set: (m: MarkStyle) => bookEdit.value && setBookStyle(settings.value, bookEdit.value.id, m),
});
function setBookMode(mode: BookStyleMode) {
  const b = bookEdit.value;
  if (!b) return;
  const current = resolveMarkStyle(settings.value, b.id);
  if (mode === 'follow') setBookColor(settings.value, b.id, null);
  else if (mode === 'tint') setBookColor(settings.value, b.id, markPrimaryColor(current));
  else setBookStyle(settings.value, b.id, current);
}

// ---------- 行内译文 ----------
const tr = computed(() => resolveTranslationStyle(settings.value));
const INLINE_MODES: { value: InlineTranslationMode; label: string; desc: string }[] = [
  { value: 'off', label: '不显示', desc: '只标记生词，点按或悬停看释义' },
  { value: 'after', label: '词后括号', desc: '生词后附简短中文' },
  { value: 'ruby', label: '词上方', desc: '小字释义在生词上方' },
  { value: 'hover', label: '悬停显示', desc: '指到生词时浮出，不占位置' },
];
function patchTr(p: Partial<{ blur: boolean; color: string; opacity: number; fontScale: number }>) {
  settings.value.inlineTranslation = { ...settings.value.inlineTranslation, ...p };
}

// ---------- 卡片颜色（高级） ----------
type CardField = 'background' | 'color' | 'accent';
const cardTarget = ref<{ field: CardField; title: string } | null>(null);
const cardSheetOpen = computed({ get: () => !!cardTarget.value, set: (v) => !v && (cardTarget.value = null) });
const cardStyle = computed(() => resolveCardStyle(settings.value));
const cardColor = computed({
  get: () => (cardTarget.value ? cardStyle.value[cardTarget.value.field] : '#ffffff'),
  set: (c: string) => {
    const f = cardTarget.value?.field;
    if (!f) return;
    if (!isCustom.value) applyCustomMark(settings.value, globalMark.value);
    settings.value.style.custom.card = { ...settings.value.style.custom.card, [f]: c };
  },
});
</script>

<template>
  <div class="preview-dock">
    <LivePreview :settings="settings" :books="books" />
  </div>

  <SettingsSection id="presets" title="样式预设" :description="`当前：${currentStyleName(settings)}。点选即生效，可在下方继续微调`">
    <div class="gallery" role="radiogroup" aria-label="组合预设">
      <PresetCard
        v-for="t in combos"
        :key="t.id"
        :mark="t.mark"
        :name="t.name"
        :desc="t.desc"
        :translation="t.translation?.mode"
        :checked="settings.style.themeId === t.id"
        @click="applyPreset(settings, t.id)"
      />
    </div>
    <p class="muted small">带“译文”的预设会同时打开对应的行内译文；之后单独修改译文不影响样式。</p>

    <template v-if="saved.length">
      <h3 class="sub">我的样式</h3>
      <div class="gallery mine" role="radiogroup" aria-label="我的样式">
        <div v-for="s in saved" :key="s.id" class="mine-item">
          <PresetCard :mark="s.mark" :name="s.name" :checked="savedChecked(s.mark)" compact @click="applyCustomMark(settings, s.mark)" />
          <button type="button" class="del" :aria-label="'删除 ' + s.name" @click="removeSaved(s.id, s.name)"><AppIcon name="close" :size="14" /></button>
        </div>
      </div>
    </template>

    <button type="button" class="link" :aria-expanded="showSingles" @click="showSingles = !showSingles">
      单色样式（{{ singles.length }}）<AppIcon :name="showSingles ? 'up' : 'down'" :size="16" />
    </button>
    <div v-if="showSingles" class="gallery small-grid" role="radiogroup" aria-label="单色样式">
      <PresetCard v-for="t in singles" :key="t.id" :mark="t.mark" :name="t.name" :checked="settings.style.themeId === t.id" compact @click="applyPreset(settings, t.id)" />
    </div>
    <button type="button" class="link" :aria-expanded="showLegacy" @click="showLegacy = !showLegacy">
      旧版配色（{{ legacy.length }}）<AppIcon :name="showLegacy ? 'up' : 'down'" :size="16" />
    </button>
    <div v-if="showLegacy" class="gallery small-grid" role="radiogroup" aria-label="旧版配色">
      <PresetCard v-for="t in legacy" :key="t.id" :mark="t.mark" :name="t.name" :checked="settings.style.themeId === t.id" compact @click="applyPreset(settings, t.id)" />
    </div>
  </SettingsSection>

  <SettingsSection id="custom" title="微调样式" :description="isCustom ? '正在使用自定义样式' : '修改后自动切换为“自定义”，原预设不受影响'">
    <template #actions>
      <button type="button" class="btn small" @click="startSave"><AppIcon name="plus" :size="16" />另存为</button>
    </template>
    <form v-if="saving" class="save" @submit.prevent="confirmSave">
      <input v-model="saveName" type="text" aria-label="样式名称" maxlength="20" />
      <button type="button" class="btn" @click="saving = false">取消</button>
      <button type="submit" class="btn primary" :disabled="!saveName.trim()">保存</button>
    </form>
    <StyleEditor v-model="editorMark" />
  </SettingsSection>

  <SettingsSection id="per-book" title="按词书设置样式" description="同时启用多本词书时，用不同颜色或样式区分生词来自哪本书" flush>
    <template #actions>
      <button v-if="enabledBooks.length > 1" type="button" class="btn small" @click="autoAssignBookColors(settings)">
        <AppIcon name="sparkle" :size="16" />自动分色
      </button>
    </template>
    <ul v-if="enabledBooks.length" class="books">
      <li v-for="b in enabledBooks" :key="b.id">
        <button type="button" class="book" @click="bookEdit = { id: b.id, name: b.name }">
          <span class="paper-mini"><MarkPreview :mark="b.mark" word="word" /></span>
          <span class="bname">
            <span>{{ b.name }}</span>
            <span class="muted">{{ MODE_LABEL[b.mode] }}</span>
          </span>
          <AppIcon name="chevron" :size="18" class="chev" />
        </button>
      </li>
    </ul>
    <p v-else class="empty muted">还没有启用词书。</p>
  </SettingsSection>

  <SettingsSection id="inline" title="行内译文" description="在生词旁直接显示简短中文，读长文不必逐个点开；与生词样式相互独立">
    <div class="modes" role="radiogroup" aria-label="行内译文位置">
      <button
        v-for="mo in INLINE_MODES"
        :key="mo.value"
        type="button"
        role="radio"
        class="mode"
        :aria-checked="settings.inlineTranslation.mode === mo.value"
        @click="settings.inlineTranslation.mode = mo.value"
      >
        <span class="radio" />
        <span class="mode-text"><strong>{{ mo.label }}</strong><span class="muted">{{ mo.desc }}</span></span>
      </button>
    </div>
    <template v-if="settings.inlineTranslation.mode !== 'off'">
      <span class="lbl">译文颜色</span>
      <ColorRow :model-value="tr.color" label="译文颜色" empty-label="跟随正文颜色" @update:model-value="(c: string) => patchTr({ color: c })" />
      <label class="slider">
        <span>浓淡 {{ Math.round(tr.opacity * 100) }}%</span>
        <input type="range" min="0.2" max="1" step="0.05" :value="tr.opacity" @input="patchTr({ opacity: Number(($event.target as HTMLInputElement).value) })" />
      </label>
      <label class="slider">
        <span>字号 {{ Math.round(tr.fontScale * 100) }}%</span>
        <input type="range" min="0.5" max="1" step="0.05" :value="tr.fontScale" @input="patchTr({ fontScale: Number(($event.target as HTMLInputElement).value) })" />
      </label>
      <ToggleSwitch
        :model-value="tr.blur"
        label="模糊自测"
        description="译文先模糊显示，想不起来时点一下才看清，适合检验记忆"
        @update:model-value="(v: boolean) => patchTr({ blur: v })"
      />
      <p class="muted small">单行标题、按钮、导航等放不下的位置，译文会自动改为悬停显示，不会撑破排版。</p>
    </template>
  </SettingsSection>

  <SettingsSection id="card" title="释义卡片" description="生词的释义卡片怎样打开；手机、平板上始终点按生词打开">
    <CardTriggerSection />
    <details class="advanced">
      <summary>卡片颜色</summary>
      <div class="fields">
        <button type="button" class="field" @click="cardTarget = { field: 'background', title: '卡片背景' }">
          <span>背景</span><i class="chip" :style="{ background: cardStyle.background }" />
        </button>
        <button type="button" class="field" @click="cardTarget = { field: 'color', title: '卡片文字' }">
          <span>文字</span><i class="chip" :style="{ background: cardStyle.color }" />
        </button>
        <button type="button" class="field" @click="cardTarget = { field: 'accent', title: '卡片强调色' }">
          <span>强调色</span><i class="chip" :style="{ background: cardStyle.accent }" />
        </button>
      </div>
      <p class="muted small">卡片默认跟随所选预设的强调色，在深色网页上自动换为深色卡片。</p>
    </details>
  </SettingsSection>

  <BottomSheet v-model:open="bookSheetOpen" :title="bookEdit?.name ?? ''" description="这本词书中的生词如何显示">
    <div v-if="bookEdit" class="book-sheet">
      <div class="book-pv">Scientists remain <MarkPreview :mark="editingMark" word="skeptical" /> about it.</div>
      <SegmentedControl
        :model-value="editingMode"
        :options="[
          { value: 'follow', label: '跟随全局' },
          { value: 'tint', label: '只换颜色' },
          { value: 'own', label: '独立样式' },
        ]"
        @update:model-value="setBookMode"
      />
      <template v-if="editingMode === 'tint'">
        <p class="muted small">与全局样式相同，只换颜色；全局样式改变时自动跟随。</p>
        <ColorRow :model-value="markPrimaryColor(editingMark)" label="词书颜色" @update:model-value="(c: string) => setBookColor(settings, bookEdit!.id, c)" />
      </template>
      <template v-else-if="editingMode === 'own'">
        <p class="muted small">从预设开始，或直接调整；不随全局样式变化。</p>
        <div class="strip" role="radiogroup" aria-label="从预设开始">
          <PresetCard
            v-for="t in [...combos, ...singles]"
            :key="t.id"
            :mark="t.mark"
            :name="t.name"
            :checked="JSON.stringify(t.mark) === JSON.stringify(editingMark)"
            compact
            @click="setBookStyle(settings, bookEdit!.id, t.mark)"
          />
          <PresetCard
            v-for="s in saved"
            :key="s.id"
            :mark="s.mark"
            :name="s.name"
            :checked="JSON.stringify(s.mark) === JSON.stringify(editingMark)"
            compact
            @click="setBookStyle(settings, bookEdit!.id, s.mark)"
          />
        </div>
        <StyleEditor v-model="editingMark" />
      </template>
      <p v-else class="muted small">使用全局样式“{{ currentStyleName(settings) }}”。</p>
    </div>
    <template #footer>
      <button type="button" class="btn primary" @click="bookEdit = null">完成</button>
    </template>
  </BottomSheet>

  <ColorSheet v-if="cardTarget" v-model:open="cardSheetOpen" v-model:color="cardColor" :title="cardTarget.title" :alpha="cardTarget.field === 'background'" />
</template>

<style scoped>
.preview-dock { position: sticky; top: 0; z-index: 5; padding: 0 0 4px; background: var(--bg); }
@media (max-width: 899px) { .preview-dock { top: 56px; margin: 0 -12px; padding: 0 12px 6px; } }
@media (min-width: 900px) { .preview-dock { padding-top: 8px; margin-top: -8px; } }

.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
.gallery.small-grid, .gallery.mine { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }
@media (max-width: 480px) {
  .gallery { grid-template-columns: 1fr 1fr; gap: 8px; }
  .gallery.small-grid, .gallery.mine { grid-template-columns: repeat(3, 1fr); gap: 6px; }
}
.mine-item { position: relative; display: flex; }
.mine-item > :first-child { flex: 1; }
.del { position: absolute; top: -6px; right: -6px; width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--border); background: var(--surface);
  color: var(--text-2); display: grid; place-items: center; cursor: pointer; padding: 0; }
@media (pointer: coarse) { .del { width: 32px; height: 32px; } }
.sub { margin: 6px 0 0; font-size: 14px; }
.small { font-size: 12px; margin: 0; }
.link { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--text-2);
  cursor: pointer; min-height: 36px; padding: 0; font-size: 13px; }
.save { display: flex; gap: 8px; }
.save input { flex: 1; min-width: 0; }

.books { list-style: none; margin: 0; padding: 0; }
.book { width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 18px; min-height: 60px; border: 0;
  border-top: 1px solid var(--border); background: transparent; cursor: pointer; text-align: left; color: var(--text); }
.book:hover { background: var(--surface-2); }
.paper-mini { display: grid; place-items: center; width: 72px; height: 36px; border-radius: 8px; background: #fff; color: #1f2328; font: 15px/1 Georgia, serif;
  border: 1px solid rgba(0, 0, 0, .06); flex: none; }
.bname { flex: 1; min-width: 0; display: flex; flex-direction: column; font-weight: 600; }
.bname > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bname .muted { font-weight: 400; font-size: 12px; }
.chev { color: var(--text-2); }
.empty { padding: 4px 18px 12px; margin: 0; }

.modes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.mode { display: flex; align-items: flex-start; gap: 8px; padding: 10px; border-radius: 12px; border: 1.5px solid var(--border);
  background: var(--surface); cursor: pointer; text-align: left; color: var(--text); min-height: var(--tap); }
.mode[aria-checked='true'] { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.mode-text { display: flex; flex-direction: column; min-width: 0; }
.mode-text .muted { font-size: 12px; }
.radio { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--border); flex: none; margin-top: 2px; }
.mode[aria-checked='true'] .radio { border: 5px solid var(--accent); }
@media (max-width: 720px) { .modes { grid-template-columns: 1fr 1fr; } }
.lbl { font-size: 13px; font-weight: 600; color: var(--text-2); }
.slider { display: grid; grid-template-columns: 7.5em 1fr; align-items: center; gap: 10px; min-height: var(--tap); font-size: 13px; }
.slider input { width: 100%; accent-color: var(--accent); }

.advanced summary { cursor: pointer; color: var(--text-2); font-size: 13px; min-height: 36px; display: flex; align-items: center; }
.fields { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 6px 0; }
@media (max-width: 480px) { .fields { grid-template-columns: 1fr; } }
.field { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: var(--tap); padding: 6px 10px 6px 12px;
  border-radius: 10px; border: 1px solid var(--border); background: var(--surface); cursor: pointer; color: var(--text); }
.chip { width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--border); flex: none; }

.book-sheet { display: flex; flex-direction: column; gap: 12px; }
.book-pv { text-align: center; padding: 14px; border-radius: 10px; background: #fff; color: #1f2328; font: 17px/1.6 Georgia, serif; border: 1px solid var(--border); }
.strip { display: grid; grid-auto-flow: column; grid-auto-columns: 96px; gap: 8px; overflow-x: auto; padding: 4px 2px 8px; scroll-snap-type: x proximity; }
.strip > * { scroll-snap-align: start; }
.btn.small { min-height: 32px; padding: 4px 12px; font-size: 13px; }
@media (pointer: coarse) { .btn.small { min-height: 40px; } }
@media (max-width: 480px) { .book { padding: 10px 14px; } .empty { padding: 4px 14px 12px; } }
</style>

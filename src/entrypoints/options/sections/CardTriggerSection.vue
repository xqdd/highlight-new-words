<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { CardHoverDelay, CardModifierKey } from '@/core/settings/schema';
import AppIcon from '@/ui/components/AppIcon.vue';
import SegmentedControl from '@/ui/components/SegmentedControl.vue';
import EngineWord from '../components/EngineWord.vue';
// 修饰键选项、显示名与平台换算复用 card 的纯函数（与卡片首次提示同一套文案）
import { effectiveModifier, isMacPlatform, modifierChoices, modifierLabel, modifierShort } from '@/content/card/trigger-config';
import { CARD_TRIGGER_MODES, HOVER_DELAY_OPTIONS, delaySeconds, modifierKeyNote, showsHoverDelay, type DesktopMode } from '../lib/card-trigger';
import { useOptions } from '../lib/context';

/**
 * 电脑上查词卡片的打开方式（v11，settings.card.trigger / card.modifier，触发实现见 card 模块 trigger）：
 * 鼠标悬停（默认）/ 按住修饰键 + 悬停 / 点击。触屏设备始终点按，不受此设置影响，所以标注“仅电脑端”，
 * 在触屏设备上打开选项页时额外说明本机不受影响（设置会随同步应用到电脑）。
 * 下方“试一试”按当前选择的方式就地演示（不依赖内容脚本），让用户在设置里就能确认生效的方式。
 * 对标：沉浸式翻译“鼠标悬停”页（触发键下拉 + 演示动画，手机端换成手势设置）、Relingo“查词交互”（悬停/点击/无）。
 */
const { settings } = useOptions();
const mac = isMacPlatform();
/** 触屏判断：没有悬停能力或主指针是粗指针（手指）；随媒体特性变化更新（平板接上/拔下鼠标键盘） */
const touchQuery = matchMedia('(hover: none), (pointer: coarse)');
const touchOnly = ref(touchQuery.matches);
const onTouchChange = () => (touchOnly.value = touchQuery.matches);
/** 触屏上电脑端选项默认收成一行（“电脑上的打开方式：鼠标悬停 ›”），点开再改 */
const desktopOpen = ref(false);
const showDesktopOptions = computed(() => !touchOnly.value || desktopOpen.value);

/** auto 是旧默认值，行为与 hover 相同，界面上合并为“鼠标悬停” */
const mode = computed<DesktopMode>({
  get: () => (settings.value.card.trigger === 'auto' ? 'hover' : (settings.value.card.trigger as DesktopMode)),
  set: (v: DesktopMode) => (settings.value.card.trigger = v),
});

/** macOS 提供 ⌘；其他系统没有 meta 选项（同步过来的 meta 由 card 按 Ctrl 处理，界面上也显示为 Ctrl） */
const KEYS = modifierChoices(mac);
const modifier = computed<CardModifierKey>({
  get: () => effectiveModifier(settings.value.card.modifier, mac),
  set: (v) => (settings.value.card.modifier = v),
});
const keyShort = computed(() => modifierShort(modifier.value, mac));
/** “新标签打开链接”在 mac 上是 ⌘+点击，其他系统是 Ctrl+点击 */
const newTabKey = mac ? '⌘' : 'Ctrl';

/** 选项卡副标题是固定文案，不随所选修饰键变化（具体键只在下方键选择区与说明中出现） */
const MODES = CARD_TRIGGER_MODES;

/** 悬停延迟（settings.card.hoverDelay，card 修复轮新增）：悬停与“修饰键 + 悬停”移入单词时生效，“试一试”演示用同一延迟 */
const hoverDelay = computed<CardHoverDelay>({
  get: () => settings.value.card.hoverDelay,
  set: (v) => (settings.value.card.hoverDelay = v),
});
/** SegmentedControl 只接受字符串值：档位转成字符串展示，写回时转回数字 */
const DELAY_SEG = HOVER_DELAY_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }));
const hoverDelayKey = computed({
  get: () => String(hoverDelay.value),
  set: (v: string) => (hoverDelay.value = Number(v) as CardHoverDelay),
});
/** 演示里“指针已在单词上再按修饰键”的延迟，与 card trigger 的 KEY_SHOW_DELAY 一致 */
const KEY_SHOW_DELAY = 180;

/** 当前方式的一句话说明（含与链接、常用快捷键的关系） */
const summary = computed(() => {
  if (mode.value === 'hover') return `把鼠标移到生词上约 ${delaySeconds(hoverDelay.value)}弹出释义，移开后自动关闭；链接照常点击打开。`;
  if (mode.value === 'click')
    return `点击生词弹出释义。链接里的生词第一次点击只弹释义，再点一次才打开链接；按住 ${newTabKey} 点击则直接在新标签打开。`;
  return `按住 ${keyShort.value} 再把鼠标移到生词上查看释义；先移上去再按 ${keyShort.value} 也可以。不按键时悬停不弹出。`;
});
/** 修饰键与浏览器常用操作的关系：查词只需“按住 + 悬停”，不必点击，所以不会触发这些操作 */
const keyNote = computed(() => modifierKeyNote(modifier.value, mac));

// ---------- 试一试：按当前方式就地演示（生词用 engine 真实渲染，链接内的词保留链接色，见 EngineWord） ----------
/** 当前打开演示卡片的词（null 为关闭） */
const demoOpen = ref<'serendipity' | 'exhibition' | null>(null);
const demoHover = ref<'serendipity' | 'exhibition' | null>(null);
const demoNote = ref('');
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let leaveTimer: ReturnType<typeof setTimeout> | undefined;
/** 键盘上是否按住了所选修饰键（keydown/keyup 跟踪，支持“先悬停后按键”） */
const keyHeld = ref(false);
const KEY_NAME: Record<CardModifierKey, string> = { alt: 'Alt', ctrl: 'Control', shift: 'Shift', meta: 'Meta' };
const activeKey = modifier;

function onKey(e: KeyboardEvent) {
  if (e.key !== KEY_NAME[activeKey.value]) return;
  keyHeld.value = e.type === 'keydown';
  // 指针已在单词上再按下修饰键：与 card 一致，180ms 后打开
  const word = demoHover.value;
  if (keyHeld.value && mode.value === 'modifier' && word && demoOpen.value !== word) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => (demoOpen.value = word), KEY_SHOW_DELAY);
  }
}
const releaseKeys = () => (keyHeld.value = false);
onMounted(() => {
  touchQuery.addEventListener('change', onTouchChange);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', releaseKeys);
});
onUnmounted(() => {
  touchQuery.removeEventListener('change', onTouchChange);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('keyup', onKey);
  window.removeEventListener('blur', releaseKeys);
  clearTimeout(hoverTimer);
  clearTimeout(leaveTimer);
});
// 切换方式时收起演示卡片，避免残留上一种方式的状态
watch([mode, modifier], () => {
  demoOpen.value = null;
  demoNote.value = '';
});

function onEnter(word: 'serendipity' | 'exhibition', e: PointerEvent) {
  if (e.pointerType !== 'mouse') return;
  clearTimeout(leaveTimer);
  demoHover.value = word;
  // 悬停与“按着修饰键移入”都按所选悬停延迟打开（与页面上的卡片一致）
  const held = { alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey }[activeKey.value] || keyHeld.value;
  if (mode.value === 'hover' || (mode.value === 'modifier' && held)) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => (demoOpen.value = word), hoverDelay.value);
  }
}
function onLeave(e: PointerEvent) {
  if (e.pointerType !== 'mouse') return;
  clearTimeout(hoverTimer);
  demoHover.value = null;
  if (mode.value !== 'click') leaveTimer = setTimeout(() => (demoOpen.value = null), 250);
}
/** 点击：click 方式或触屏点按时打开；链接中的词第一次点击只弹释义，再次点击（或新标签修饰键）演示“打开链接” */
function onClick(word: 'serendipity' | 'exhibition', e: MouseEvent, inLink: boolean) {
  const tapLike = mode.value === 'click' || (e as PointerEvent).pointerType === 'touch' || touchOnly.value;
  if (inLink) e.preventDefault();
  const newTab = mac ? e.metaKey : e.ctrlKey;
  if (inLink && newTab) {
    demoNote.value = '演示：这里会在新标签打开链接';
    return;
  }
  if (!tapLike) {
    if (inLink) demoNote.value = '演示：这里会打开链接';
    return;
  }
  if (demoOpen.value === word) {
    demoNote.value = inLink ? '演示：第二次点击，这里会打开链接' : '';
    if (!inLink) demoOpen.value = null;
    return;
  }
  demoNote.value = '';
  demoOpen.value = word;
}

const GLOSS = {
  serendipity: { phon: '/ˌserənˈdɪpəti/', def: 'n. 机缘巧合；意外发现珍奇事物的本领' },
  exhibition: { phon: '/ˌeksɪˈbɪʃn/', def: 'n. 展览；展览会' },
};
const demoHint = computed(() => {
  if (touchOnly.value) return '点按带标记的单词试试';
  if (mode.value === 'hover') return '把鼠标移到带标记的单词上试试';
  if (mode.value === 'modifier') return `按住 ${keyShort.value}，再把鼠标移到带标记的单词上试试`;
  return '点击带标记的单词试试，也可以点链接里的 exhibition';
});
</script>

<template>
  <div class="trigger">
    <!-- 触屏：收成一行，点开才显示电脑端选项 -->
    <button v-if="touchOnly" type="button" class="collapsed" :aria-expanded="desktopOpen" @click="desktopOpen = !desktopOpen">
      <span class="lbl">电脑上的打开方式：</span><strong>{{ MODES.find((m) => m.value === mode)?.label }}</strong>
      <span class="badge">仅电脑端</span>
      <AppIcon :name="desktopOpen ? 'up' : 'down'" :size="16" class="chev" />
    </button>
    <div v-else class="head">
      <span class="lbl">电脑上的打开方式</span>
      <span class="badge">仅电脑端</span>
    </div>
    <p v-if="touchOnly && desktopOpen" class="touch-note muted">本机是触屏设备，点按生词查看释义（可在下方关闭），不受此设置影响；这里的选择会随同步应用到你的电脑。</p>
    <template v-if="showDesktopOptions">
    <div class="modes" role="radiogroup" aria-label="电脑上的卡片打开方式">
      <button
        v-for="mo in MODES"
        :key="mo.value"
        type="button"
        role="radio"
        class="mode"
        :aria-checked="mode === mo.value"
        @click="mode = mo.value"
      >
        <span class="radio" />
        <span class="mode-text"><strong>{{ mo.label }}</strong><span class="muted">{{ mo.desc }}</span></span>
      </button>
    </div>

    <div v-if="mode === 'modifier'" class="keys">
      <span class="lbl">修饰键</span>
      <div class="keycaps" role="radiogroup" aria-label="修饰键">
        <button
          v-for="k in KEYS"
          :key="k"
          type="button"
          role="radio"
          class="keycap"
          :aria-checked="modifier === k"
          @click="modifier = k"
        >
          <kbd>{{ modifierLabel(k, mac) }}</kbd>
        </button>
      </div>
      <p class="note">{{ keyNote }}</p>
    </div>

    <div v-if="showsHoverDelay(mode)" class="delay">
      <span class="lbl">悬停延迟</span>
      <SegmentedControl v-model="hoverDelayKey" class="delays" :options="DELAY_SEG" aria-label="悬停延迟" />
      <p class="note">指针在生词上停留多久才弹出（默认 250ms）。越慢越不容易误触，扫过段落时不会接连弹出卡片。</p>
    </div>

    <p class="summary">{{ summary }}</p>
    </template>

    <div class="demo" data-pv-tr="off">
      <span class="demo-hint muted">试一试 · {{ demoHint }}</span>
      <p class="demo-text">
        It was pure
        <span class="w" @pointerenter="onEnter('serendipity', $event)" @pointerleave="onLeave" @click="onClick('serendipity', $event, false)">
          <EngineWord :settings="settings" word="serendipity" />
        </span>
        that we met at the
        <a href="#" class="w link" @pointerenter="onEnter('exhibition', $event)" @pointerleave="onLeave" @click="onClick('exhibition', $event, true)">
          <EngineWord :settings="settings" word="exhibition" />
        </a>.
      </p>
      <div v-if="demoOpen" class="pop" role="status">
        <strong>{{ demoOpen }}</strong> <span class="muted">{{ GLOSS[demoOpen].phon }}</span>
        <div>{{ GLOSS[demoOpen].def }}</div>
      </div>
      <p v-if="demoNote" class="demo-note" role="status">{{ demoNote }}</p>
    </div>
  </div>
</template>

<style scoped>
.trigger { display: flex; flex-direction: column; gap: 10px; }
.head { display: flex; align-items: center; gap: 8px; }
.lbl { font-size: 13px; font-weight: 600; color: var(--text-2); }
.badge { font-size: 11px; line-height: 18px; padding: 0 7px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-2); }
.touch-note { margin: 0; font-size: 12px; padding: 8px 10px; border-radius: 10px; background: var(--accent-soft); color: var(--text); }
.modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.mode { display: flex; align-items: flex-start; gap: 8px; padding: 10px; border-radius: 12px; border: 1.5px solid var(--border);
  background: var(--surface); cursor: pointer; text-align: left; color: var(--text); min-height: var(--tap); }
.mode[aria-checked='true'] { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.mode-text { display: flex; flex-direction: column; min-width: 0; }
.mode-text .muted { font-size: 12px; }
.radio { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--border); flex: none; margin-top: 2px; }
.mode[aria-checked='true'] .radio { border: 5px solid var(--accent); }
@media (max-width: 720px) { .modes { grid-template-columns: 1fr; } }
.keys { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px; background: var(--surface-2); }
.keycaps { display: flex; flex-wrap: wrap; gap: 8px; }
.keycap { position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: var(--tap); padding: 0 12px; border-radius: 10px;
  border: 1.5px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; }
.keycap[aria-checked='true'] { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
kbd { font-family: inherit; font-size: 13px; font-weight: 600; padding: 2px 8px; border-radius: 6px; background: var(--surface-2);
  border: 1px solid var(--border); border-bottom-width: 2px; white-space: nowrap; }
.note { margin: 0; font-size: 12px; color: var(--text-2); }
.delay { display: flex; flex-direction: column; gap: 8px; }
.delays { white-space: nowrap; max-width: 420px; }
.collapsed { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: var(--tap); padding: 6px 12px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; text-align: left; font: inherit; font-size: 14px; }
.collapsed .chev { margin-left: auto; color: var(--text-2); }
.summary { margin: 0; font-size: 13px; }
.demo { position: relative; padding: 12px 14px; border-radius: 12px; border: 1px dashed var(--border); background: var(--bg); }
.demo-hint { font-size: 12px; }
.demo-text { margin: 6px 0 0; font-size: 16px; line-height: 1.9; font-family: Georgia, 'Times New Roman', serif; }
.w { position: relative; cursor: default; }
.link { color: #1a5fb4; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
:root[data-theme='dark'] .link { color: #78aeed; }
@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) .link { color: #78aeed; } }
/* 演示卡片放在句子下方（不浮在单词上），手机窄屏也不会溢出 */
.pop { margin-top: 8px; padding: 8px 12px; border-radius: 10px; background: var(--surface); color: var(--text); border: 1px solid var(--border);
  border-left: 3px solid var(--accent); box-shadow: var(--shadow); font-size: 13px; line-height: 1.5; }
.demo-note { margin: 4px 0 0; font-size: 12px; color: var(--accent); }
</style>

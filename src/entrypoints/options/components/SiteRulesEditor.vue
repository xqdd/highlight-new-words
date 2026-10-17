<script setup lang="ts">
import { computed, ref } from 'vue';
import AppIcon from '@/ui/components/AppIcon.vue';
import { evaluateSiteRules, matchesSiteRule, siteUrl, validateSiteRule, type SiteRuleKind, type SiteRules } from '@/core/sites/rules';
import { showToast } from '../lib/toast';

const props = defineProps<{ modelValue: SiteRules; label: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: SiteRules] }>();
const list = ref<'disabled' | 'allowed'>('disabled');
const kind = ref<SiteRuleKind>('domain');
const input = ref('');
const preview = ref('');
const error = ref('');
const placeholder = computed(() => kind.value === 'domain' ? 'example.com 或完整网址' : kind.value === 'glob' ? 'https://*.example.com/news/**' : '/^https?:\\/\\/example\\.com\\//i');
const previewResult = computed(() => preview.value.trim() && siteUrl(preview.value.trim()) ? evaluateSiteRules(props.modelValue, preview.value.trim()) : undefined);
const previewDraft = computed(() => {
  if (!input.value.trim() || !preview.value.trim()) return undefined;
  const rule = encodedRule();
  return validateSiteRule(rule) ? undefined : matchesSiteRule(rule, preview.value.trim());
});

/** 域名模式接受粘贴网址；通配符和正则保留路径、大小写和原始表达式。 */
function encodedRule() {
  let value = input.value.trim();
  if (kind.value === 'domain' && value.includes('://')) value = siteUrl(value)?.hostname ?? value;
  return `${kind.value}:${value}`;
}
/** 子组件收到的数组是Vue代理，跨组件保存时重建纯数据，避免storage序列化失败。 */
function updateRules(patch: Partial<SiteRules>) {
  const next = { ...props.modelValue, ...patch };
  emit('update:modelValue', { mode: next.mode, disabled: [...next.disabled], allowed: [...next.allowed] });
}
function add() {
  const rule = encodedRule();
  error.value = validateSiteRule(rule) ?? '';
  if (error.value) return;
  if (props.modelValue[list.value].includes(rule)) { error.value = '规则已存在'; return; }
  updateRules({ [list.value]: [...props.modelValue[list.value], rule] });
  input.value = '';
}
function remove(rule: string, target: 'disabled' | 'allowed') {
  const index = props.modelValue[target].indexOf(rule);
  updateRules({ [target]: props.modelValue[target].filter(item => item !== rule) });
  showToast(`已移除 ${rule}`, { action: { label: '撤销', run: () => {
    const next = [...props.modelValue[target]];
    if (!next.includes(rule)) next.splice(Math.min(index, next.length), 0, rule);
    updateRules({ [target]: next });
  } } });
}
</script>

<template>
  <div class="rules-editor" :aria-label="label" role="group">
    <fieldset class="mode">
      <legend>生效范围</legend>
      <label><input type="radio" :name="label + '-mode'" :checked="modelValue.mode === 'all'" @change="updateRules({ mode: 'all' })">所有网站</label>
      <label><input type="radio" :name="label + '-mode'" :checked="modelValue.mode === 'allowlist'" @change="updateRules({ mode: 'allowlist' })">仅白名单</label>
    </fieldset>
    <form class="rule-form" @submit.prevent="add">
      <label class="compact">名单<select v-model="list" :aria-label="label + '名单'"><option value="disabled">黑名单</option><option value="allowed">白名单</option></select></label>
      <label class="compact">规则类型<select v-model="kind" :aria-label="label + '规则类型'" @change="error = ''"><option value="domain">域名</option><option value="glob">通配符</option><option value="regex">受限正则</option></select></label>
      <label class="rule-input">匹配规则<input v-model="input" type="text" :aria-label="label + '匹配规则'" :placeholder="placeholder" autocapitalize="off" spellcheck="false" @input="error = ''"></label>
      <button type="submit" class="btn" :disabled="!input.trim()"><AppIcon name="plus" :size="16" />添加</button>
    </form>
    <p v-if="error" class="rule-error" role="alert">{{ error }}</p>
    <div class="lists">
      <div v-for="target in (['disabled', 'allowed'] as const)" :key="target" class="rule-list">
        <h4>{{ target === 'disabled' ? '黑名单' : '白名单' }} <span class="muted">{{ modelValue[target].length }}</span></h4>
        <ul v-if="modelValue[target].length">
          <li v-for="rule in modelValue[target]" :key="rule">
            <span :title="rule">{{ rule }}</span>
            <button type="button" :aria-label="label + '移除 ' + rule" :title="'移除 ' + rule" @click="remove(rule, target)"><AppIcon name="close" :size="14" /></button>
          </li>
        </ul>
        <p v-else class="muted empty">未添加规则</p>
      </div>
    </div>
    <label class="preview">匹配预览<input v-model="preview" type="text" :aria-label="label + '匹配预览'" placeholder="输入域名或完整网址" autocapitalize="off" spellcheck="false"></label>
    <output v-if="preview.trim()" class="preview-result" :data-site-result="previewResult ? (previewResult.disabled ? 'blocked' : 'allowed') : 'invalid'">
      <template v-if="previewResult">
        <strong>{{ previewResult.disabled ? '不启用' : '启用' }}</strong>
        <span v-if="previewResult.blockedBy">命中黑名单：{{ previewResult.blockedBy }}</span>
        <span v-else-if="modelValue.mode === 'allowlist'">{{ previewResult.allowedBy ? '命中白名单：' + previewResult.allowedBy : '未命中白名单' }}</span>
        <span v-else>所有网站范围内</span>
      </template>
      <span v-else>请输入有效的域名或 HTTP(S) 网址</span>
      <span v-if="previewDraft !== undefined">待添加规则：{{ previewDraft ? '匹配' : '不匹配' }}</span>
    </output>
  </div>
</template>

<style scoped>
.rules-editor { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
fieldset { border: 0; padding: 0; margin: 0; }
.mode { display: flex; gap: 18px; flex-wrap: wrap; }
.mode legend { margin-bottom: 8px; font-size: 13px; color: var(--text-2); }
.mode label { display: inline-flex; align-items: center; gap: 6px; }
.rule-form { display: flex; align-items: end; gap: 8px; flex-wrap: wrap; }
.compact,.rule-input,.preview { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-2); }
.rule-input { flex: 1; min-width: 180px; }
.rule-form .btn { min-height: 38px; }
.lists { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 20px; }
h4 { font-size: 13px; margin: 0 0 8px; font-weight: 600; }
h4 span { margin-left: 6px; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
li { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 0; border-bottom: 1px solid var(--border); }
li span { flex: 1; min-width: 0; overflow-wrap: anywhere; font: 12px/1.5 var(--font-mono,monospace); }
li button { flex: 0 0 28px; width: 28px; height: 28px; border: 0; border-radius: 4px; background: transparent; color: var(--text-2); display: grid; place-items: center; cursor: pointer; }
li button:hover { background: var(--danger-soft); color: var(--danger); }
.empty { font-size: 12px; margin: 0; }
.rule-error { color: var(--danger); font-size: 12px; margin: 0; }
.preview-result { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 12px; overflow-wrap: anywhere; }
.preview-result strong { font-weight: 600; }
@media(max-width:600px) { .lists { grid-template-columns: minmax(0,1fr); gap: 14px; } .rule-input { min-width: 100%; } .preview input { width: 100%; min-width: 0; } }
</style>

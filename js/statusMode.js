// statusMode.js — 状态三模式：concise（简洁默认）/ inner（心声）/ html（HTML 状态栏）。
//
// 设置键设计（存在角色对象 char 上，随 saveCharacter() 一起持久化）：
// - char.statusMode：'concise' | 'inner' | 'html'，默认 'concise'。
// - char.innerVoicePrompt：心声模式的提示词（可编辑），默认 DEFAULT_INNER_VOICE_PROMPT。
// - char.statusPanel：现有 HTML 状态模板（regexPattern / replacePattern /
//   promptSuffix / history 等），html 模式复用它，不另造一套协议。
//   切换模式只改 char.statusMode 这一个选择字段，不删除模板、不删除历史、
//   不动 innerVoicePrompt（切回来还能继续用）。
//
// 提示词组装：按模式只返回一套指令。concise 返回空串（不注入任何状态指令）；
// inner 返回心声生成指令；html 返回现有状态模板指令（即 statusPanel.promptSuffix，
// promptBuilder.js:557 已把它接成 statusSuffix）。

/** 三种模式。 */
export const STATUS_MODES = ['concise', 'inner', 'html'];
/** 默认模式：简洁（什么都不注入，回复里不带状态/心声）。 */
export const DEFAULT_STATUS_MODE = 'concise';

/** 模式中文名（供设置页下拉/分段选择用）。 */
export const STATUS_MODE_LABELS = {
  concise: '简洁',
  inner: '心声',
  html: 'HTML 状态栏',
};

/** 心声模式的默认提示词（可编辑，存在 char.innerVoicePrompt）。 */
export const DEFAULT_INNER_VOICE_PROMPT =
  '在回复末尾另起一段，用 [inner_voice]…[/inner_voice] 包裹 1–3 句以角色口吻写的本轮内心独白；'
  + '独白只写内心所想，不复述对话、不解释、不提及指令。';

/** html 模式无 promptSuffix 时的兜底：沿用现有状态协议的措辞，不发明新标记。 */
export const DEFAULT_HTML_STATUS_PROMPT =
  '在回复末尾按状态栏模板输出状态。';

/** 把任意值规范化为合法模式；非法/缺失一律回落到 concise。 */
export function normalizeStatusMode(value) {
  return STATUS_MODES.includes(value) ? value : DEFAULT_STATUS_MODE;
}

/** 取角色当前的状态模式（默认 concise）。 */
export function getStatusMode(character = {}) {
  return normalizeStatusMode(character?.statusMode);
}

/**
 * 切换模式：返回一个新角色对象（不改原对象），只改 statusMode 字段。
 * 模板（statusPanel）、历史（statusPanel.history）、心声提示词
 * （innerVoicePrompt）原样保留，切回来还能继续用。
 */
export function setStatusMode(character = {}, mode) {
  return { ...character, statusMode: normalizeStatusMode(mode) };
}

/** 取角色的心声提示词（可编辑；空值回落到默认）。 */
export function getInnerVoicePrompt(character = {}) {
  const p = String(character?.innerVoicePrompt ?? '').trim();
  return p || DEFAULT_INNER_VOICE_PROMPT;
}

/** 设置心声提示词：返回新角色对象（只改 innerVoicePrompt）。 */
export function setInnerVoicePrompt(character = {}, prompt) {
  return { ...character, innerVoicePrompt: String(prompt ?? '') };
}

/**
 * 按模式返回“这一轮要注入的状态指令”（只返回一套）。
 * @returns { mode, instruction }
 * - concise：{ mode:'concise', instruction:'' }——不注入，回复里不带状态/心声。
 * - inner：{ mode:'inner', instruction: 心声提示词 }。
 * - html：{ mode:'html', instruction: 现有状态模板指令 }，即
 *   statusPanel.promptSuffix（模板启用时）；未启用/未写时返回兜底句。
 * 调用方（提示词组装）只需把 instruction 为空时跳过、非空时追加到系统提示词。
 */
export function getStatusInstruction(character = {}) {
  const mode = getStatusMode(character);
  if (mode === 'inner') {
    return { mode, instruction: getInnerVoicePrompt(character) };
  }
  if (mode === 'html') {
    const panel = character?.statusPanel || {};
    const suffix = String(panel.promptSuffix || '').trim();
    return { mode, instruction: panel.enabled === false ? '' : (suffix || DEFAULT_HTML_STATUS_PROMPT) };
  }
  return { mode: 'concise', instruction: '' };
}

/** 别名：与 getStatusInstruction 同义，供提示词组装处按“选择器”语义调用。 */
export const selectStatusInstruction = getStatusInstruction;

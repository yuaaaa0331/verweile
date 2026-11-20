// promptBuilder.js — 系统提示词组装（promptBuilder，与网络、界面分离）。
// 规则来源：chat_ai_prompt.js generatePrivateSystemPrompt + 指令 §二/§三。
import { buildTTPrompt, buildUWUPrompt} from './promptTemplates.js';
import { countTextTokens, nowTimeString, clampInt} from './utils.js';

export const HISTORY_PLACEHOLDER = '【动态插入: 聊天记录】';

/** 角色专属版本优先于全局版本；全局缺省为 'tt'（用户实际生效配置）。 */
export function resolvePromptVersion(character, globalSettings = {}) {
if (character?.exclusivePromptVersion) return character.exclusivePromptVersion;
const g = globalSettings?.cotSettings?.promptVersion || globalSettings?.promptVersion;
return g || 'tt';
}

/** 世界书按角色绑定的 worldBookIds 选择，分四个位置，各自按 depth 升序。 */
export function collectWorldBooks(character, worldBooks = []) {
const ids = character?.worldBookIds || [];
const byId = new Map(worldBooks.map((w) => [w.id, w]));
const out = { limitBreak: '', before: '', after: '', guidelines: ''};
for (const pos of ['limit_break', 'before', 'after', 'guidelines']) {
const key = pos === 'limit_break'? 'limitBreak': pos;
out[key] = ids
.map((id) => byId.get(id))
.filter((w) => w && w.position === pos)
.sort((a, b) => (a.depth?? 100) - (b.depth?? 100))
.map((w) => w.content)
.join('\n');
}
return out;
}

export function collectStickerNames(character, stickers = []) {
const groups = String(character?.stickerGroups || '')
.split(/[,，]/).map((s) => s.trim()).filter((s) => s && s!== '未分类');
if (!groups.length) return [];
return stickers.filter((s) => groups.includes(s.group)).map((s) => s.name);
}

export function collectFavoritedJournals(character) {
return (character?.memoryJournals || [])
.filter((j) => j.isFavorited)
.map((j) => `标题：${j.title}\n内容：${j.content}`)
.join('\n\n---\n\n');
}

/**
* 组装系统提示词。返回 { systemPrompt, version, modules, tokenEstimate, hasHistoryPlaceholder}。
* - baseline 是只读基线；character.promptOverride 是用户编辑的覆盖层（整段替换基线），
* promptOverride 为空时用基线；恢复默认 = 清空覆盖层。覆盖层永远不与基线拼接成一大段存回人设。
* - relatedMemories 是后续向量检索预留的结构化输入，默认空数组，不注入、不冒充缓存。
* - 思维链：本阶段永不注入（cotSettings.enabled=false；即使导入值为 true 也不注入）。
*/
export function buildSystemPrompt(character, deps = {}) {
const {
worldBooks = [], stickers = [], globalSettings = {},
relatedMemories = [], // [{title, content, source}]，默认 []
now = new Date(),
} = deps;
const version = resolvePromptVersion(character, globalSettings);
const wb = collectWorldBooks(character, worldBooks);
const stickerNames = collectStickerNames(character, stickers);
const favoritedJournals = collectFavoritedJournals(character);
const galleryNames = (character?.useRealGallery && Array.isArray(character?.gallery))
? character.gallery.map((p) => p.name).filter(Boolean): [];

const ctx = {
realName: character?.realName || '角色',
myName: character?.myName || '我',
status: character?.status || '在线',
persona: character?.persona || '',
myPersona: character?.myPersona || '',
currentTime: nowTimeString(now),
worldBooks: wb,
stickerNames,
galleryNames,
useRealGallery:!!character?.useRealGallery,
statusSuffix: character?.statusPanel?.enabled? (character.statusPanel.promptSuffix || ''): '',
bilingual:!!character?.bilingualModeEnabled,
// TT 分支原函数用 replyCountMin||1 / ||6，但用户实际生效值为 3—8；
// 本实现以角色值为准，缺省 3—8，不误套 1—6。见 MIGRATION.md。
replyMin: clampInt(character?.replyCountMin, 1, 20, 3),
replyMax: clampInt(character?.replyCountMax, 1, 20, 8),
replyCountEnabled:!!character?.replyCountEnabled,
favoritedJournals,
relatedMemories: (relatedMemories || [])
.map((m) => `标题：${m.title || ''}\n内容：${m.content || ''}${m.source? `\n来源：${m.source}`: ''}`)
.join('\n\n---\n\n'),
};

let systemPrompt;
if (character?.promptOverride && String(character.promptOverride).trim()) {
systemPrompt = String(character.promptOverride);
} else {
systemPrompt = version === 'tt'? buildTTPrompt(ctx): buildUWUPrompt(ctx);
}

const modules = [
{ name: '基线模板', source: version === 'tt'? 'TT 版': '默认 UWU 版', tokens: 0},
{ name: '世界书·破限', source: 'worldBooks/limit_break', tokens: countTextTokens(wb.limitBreak)},
{ name: '世界书·前', source: 'worldBooks/before', tokens: countTextTokens(wb.before)},
{ name: '角色设定', source: 'character.persona', tokens: countTextTokens(ctx.persona)},
{ name: '世界书·后', source: 'worldBooks/after', tokens: countTextTokens(wb.after)},
{ name: '世界书·准则', source: 'worldBooks/guidelines', tokens: countTextTokens(wb.guidelines)},
{ name: '用户人设', source: 'character.myPersona', tokens: countTextTokens(ctx.myPersona)},
{ name: '收藏记忆', source: 'memoryJournals（已收藏）', tokens: countTextTokens(favoritedJournals)},
{ name: '相关记忆（向量检索预留）', source: 'relatedMemories', tokens: countTextTokens(ctx.relatedMemories)},
{ name: '表情包清单', source: 'stickers（已绑定分组）', tokens: countTextTokens(stickerNames.join(', '))},
];
const dynamicTokens = modules.slice(1).reduce((s, m) => s + m.tokens, 0);
modules[0].tokens = Math.max(0, countTextTokens(systemPrompt) - dynamicTokens);

return {
systemPrompt,
version,
modules,
tokenEstimate: countTextTokens(systemPrompt),
hasHistoryPlaceholder: systemPrompt.includes(HISTORY_PLACEHOLDER),
};
}

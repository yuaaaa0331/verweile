// app.js — UWU 聊天第一阶段：独立聊天界面。
// 模块分工：promptBuilder（提示词）/ historyBuilder（上下文）/ providerAdapter（网络）/
// replyParser（解析）/ storage（持久化）/ importExport（导入导出）。本文件只做界面与编排。
import { buildSystemPrompt, resolvePromptVersion, buildRequestSignature, formatEvidenceTime } from './promptBuilder.js';
import { buildRequest, effectiveParts, extractProtocolText, messageText } from './historyBuilder.js';
import { parseReplyText, segmentToMessage, classifyContent, parseBilingual } from './replyParser.js';
import { sendChat, testConnection } from './providerAdapter.js';
import { fetchModels, testSummaryApi, testEmbeddingApi, callSummaryChat, callEmbeddings, withoutKey } from './auxApi.js';
import { countRounds, selectMessagesForRounds, unsummarizedMessages, extractSummarizableText, buildSummaryRequest, DEFAULT_SUMMARY_PROMPT } from './memorySummary.js';
import { getExperiencesForChar, extractExperiencesFromRange, updateExperience, deleteExperience, planOutcomeLabel, sourceStatusOfJournal, isExperienceValid, markExperienceInvalid } from './experiences.js';
import {
  DEFAULT_VECTOR_SETTINGS, spaceKeyFor, normalizeBaseUrl, buildRetrievalQueryText,
  indexDocuments, deleteDocumentIndexes, deleteSpaceIndex, getIndexStatus, getIndexSpaces,
  journalRetrievable, fusedRetrieve, syncDocumentIndexes, rebuildKeywordIndexForChar,
} from './vectorMemory.js';
import {
  DEFAULT_ASSOC_SETTINGS, emptyAssoc, generateCluesForExperience, runAssocForChat,
  bumpCompletedRoundSeq, settleAssocReceipt,
  checkAssocBudget, loadAssocBudget, saveAssocBudget,
  getAssocReceipts, latestReceiptForExp, receiptStatusText,
} from './associative.js';
import { IDBBackend, MemoryBackend, PAGE_SIZE, templateIdFor, saveStatusTemplate } from './storage.js';
import {
  MEMORY_JOB_LABELS, createMemoryJob, loadMemoryJobs, saveMemoryJobs,
  markInterruptedJobsPaused, memoryJobStatusText, runMemoryJob, persistMemoryJob,
  cleanupCharacterRetrievalData, executeRetrievalTask, experienceNeedsClues,
} from './retrievalWorker.js';
import {
  buildKeywordIndex, retrievalDocsForChar, retrievalDocRetrievable,
} from './keywordSearch.js';
import { decodeBackupBytes, describeBackupBytes, gzipBytes, normalizeBackup, previewCounts, importNormalized, exportAll } from './importExport.js';
import { mockReplyText, MOCK_BADGE } from './mockReply.js';
import { LiquidGlass } from './liquidGlass.js';
import { ThemeStore } from './theme.js';
import { MomentsView } from './moments.js';
import { NavShell } from './nav.js';
import { ManageView } from './manage.js';
import { uid, escapeHtml, friendlyErrorMessage, formatTimeDivider, formatTimeGap, countTextTokens, hashString } from './utils.js';
import { applyStatusTemplate, summarizeStatus, substituteTemplateVars, buildStatusDocument, statusViewEntries, clampStatusIndex, STATUS_HEIGHT_MSG, STATUS_ERROR_MSG } from './statusBar.js';
import { stickerImageSrc, stickerGroupsOf, filterStickers, knownStickerNames, STICKER_PAGE_SIZE } from './stickers.js';
// A 组集成：长按菜单 / 心声解析 / 状态三模式 / 日常体验（草稿·阅读位置·重试·恢复）。
// 这些模块不 import app.js，动作全走回调注入；接线见 docs/chat-audit.md 附表。
import { LongPressMenu, toggleReaction, reactionCounts, createDeleteToken } from './longPressMenu.js';
import { parseInnerVoice } from './innerVoice.js';
import { getStatusMode, setStatusMode, getInnerVoicePrompt, normalizeStatusMode, STATUS_MODE_LABELS, DEFAULT_INNER_VOICE_PROMPT } from './statusMode.js';
// 聊天记录中心（B 组）：搜索 / 收藏 / 日期的数据查询走 A 组模块，UI 与定位走 js/chatCenter.js。
// 注意：这里必须用原名 import（不要 `import { X as Y }`），build 脚本去掉 import 行后别名无定义。
import { searchChatMessages, getMessageText, listFavoriteMessages } from './chatSearch.js';
import { getChatDates, dayBounds, messagesForDay } from './chatDates.js';
import { SEARCH_PAGE_SIZE, FAVORITES_PAGE_SIZE, CHAT_CENTER_TYPES, buildSearchFilters, debounce, buildCalendarMonth, shiftMonth, saveMessageAsMemory, unfavoriteMessage, findFirstMessageOfDay, runJumpToMessage, searchResultItemHTML, favoriteItemHTML, calendarMonthHTML } from './chatCenter.js';
import {
  saveDraft, loadDraft, clearDraft, createDraftSaver,
  saveReadingPosition, loadReadingPosition, decideNewMessageDisplay, distanceFromBottom,
  markFailed, canRetry, retryMessage, recoverInterruptedMessages, groupLastFlags,
} from './chatDaily.js';
import { normalizeQuoteReference, followQuoteReference } from './quoteNavigation.js';
// B 组集成：通知 / 音频保活 / 推送 / 自定义图标 / 主动唤醒。
// 这些模块不 import app.js，动作全走回调注入；接线见 docs/b-group-integration.md §8。
import { InAppNotifier, saveUnread, loadUnread, renderNotifySettingsSection, NOTIFY_SETTINGS_KEY, DEFAULT_NOTIFY_SETTINGS } from './inAppNotify.js';
import { getAudioKeepAlive, renderKeepAliveSettingsSection, KEEPALIVE_SETTINGS_KEY, DEFAULT_KEEPALIVE_SETTINGS } from './audioKeepAlive.js';
import { registerServiceWorker, requestPermission, subscribePush, renderPushSettingsSection, PUSH_SETTINGS_KEY, DEFAULT_PUSH_SETTINGS } from './pushNotify.js';
import { renderIconSettingsSection, CUSTOM_ICON_SETTINGS_KEY, CUSTOM_ICON_VERSION_KEY, DEFAULT_APP_NAME, validateIconFile, computeCropRect, previewSpecs, exportIconPack, buildCustomIconVersionedUrl, uploadCustomIcon, fetchCustomIconMeta, applyCustomIconUrl, deleteCustomIcon } from './customIcon.js';
import { WakeEngine, renderWakeSettingsSection, WAKE_SETTINGS_KEY, DEFAULT_WAKE_SETTINGS, parseWakeToolCall } from './wakeEngine.js';

const $ = (s) => document.querySelector(s);
const messageArea = $('#message-area');

// 调试模式（对照原始 UWU 的 isDebugMode，db.js:470）：只在当前会话里生效，默认关闭。
// 状态更新、思考过程与隐藏指令在非调试模式下不渲染进聊天流（只进状态栏/执行状态变化）；
// 调试模式下以【调试可见】样式显示原文。切换入口在消息长按菜单里。
let isDebugMode = false;
// 聊天页 HTML 卡片 iframe 的唯一编号（高度上报按 id 路由回对应的 iframe）。
let chatHtmlSeq = 0;
const inputEl = $('#input');
const isCoarse = window.matchMedia?.('(pointer: coarse)').matches;

const backend = new IDBBackend();
let char = null;            // 当前角色（memoryJournals 已从 journals 表合并进来）
let worldBooks = [];
let stickers = [];
let apiSettings = { provider: 'openai', url: '', key: '', model: '', temperatureEnabled: false, temperature: 1.0, streamEnabled: true, timePerceptionEnabled: false };
let apiPresets = [];
// 两套独立副 API 配置：与主 API 分开存（settings 'summaryApi' / 'embeddingApi'），绝不混用。
let summaryApi = { provider: 'openai', url: '', key: '', model: '' };
let embeddingApi = { provider: 'openai', url: '', key: '', model: '' };
// 记忆总结设置（settings 'summarySettings'）：自动总结默认关闭，默认每 30 轮一轮。
let summarySettings = { autoEnabled: false, everyRounds: 30, prompt: DEFAULT_SUMMARY_PROMPT, length: 'medium', lastSummarizedMessageId: null, summarizedRounds: 0 };
let summaryRunning = false; // 总结进行中：防重复触发
let experienceRunning = false; // 经历提取进行中：防重复触发（与总结共用副 API，串行跑）
// 向量记忆设置（settings 'vectorSettings'）与索引进度（settings 'vectorIndexProgress'，
// 刷新后按已保存进度继续）。索引是可重建缓存，不随备份导出。
let vectorSettings = { ...DEFAULT_VECTOR_SETTINGS };
let vectorIndexProgress = null;
let vectorIndexRunning = false;
let vectorIndexCancel = null; // { cancelled: false }，暂停时置 true
// 联想召回设置（settings 'assocSettings'）：总开关默认开；预算记录在
// settings 'assocBudget'（{month, used, limit}，默认 300 次/月），见 associative.js。
let assocSettings = { ...DEFAULT_ASSOC_SETTINGS };
// B 组设置（settings 表键名见各模块的 *_SETTINGS_KEY；默认值为各模块的 DEFAULT_*）。
let notifySettings = { ...DEFAULT_NOTIFY_SETTINGS };
let keepAliveSettings = { ...DEFAULT_KEEPALIVE_SETTINGS };
let pushSettings = { ...DEFAULT_PUSH_SETTINGS };
let customIconSettings = { appName: DEFAULT_APP_NAME, dataUrl: null };
let wakeSettings = { ...DEFAULT_WAKE_SETTINGS };
// B 组单例（boot 里初始化；模块均不 import app.js，只拿回调）。
let inAppNotifier = null;
let audioKeepAlive = null;
let wakeEngine = null;
// 唤醒回合进行中标记：巡检不重入，且用户正在生成回复时不抢话。
let wakeRoundRunning = false;
// 批量任务队列（settings 'memoryJobs'）：用户主动启动的分批任务，进度持久化；
// 页面关闭后任务不会在后台继续，回来显示“已暂停/未完成”，点继续可接着做；
// 任务不开机自动跑。一次只跑一个任务。
let memoryJobs = {};
let memoryJobRunning = null; // 正在跑的任务 id
let memoryJobCancel = null; // { cancelled: false }，暂停时置 true
let memoryJobScratch = new Map(); // jobId -> 关键词重建算好的 postings（恢复写阶段时复用）
let appearanceSettings = null; // 外观/背景/玻璃参数（settings 表 'appearance'），不随备份导出
// 全局提示词设置：导入备份的 cotSettings 落在这里（settings 表 'cotSettings'），
// 角色未指定专属版本时跟随它；缺省为 tt。之前这里写死 'tt'，导入的设置根本没用上。
let globalSettings = { cotSettings: { promptVersion: 'tt' } };
// 最近一次构建的请求：预览与 Get Reply 共用同一份；历史/设置一变就失效重建。
let lastBuiltRequest = null;
let currentQuote = null;
// 返回按钮的目的地：上一次离开聊天页时所在的非聊天页（默认动态）；
// 单角色应用没有会话列表，“主界面”就是带 Tab 栏的页。
let lastHomeView = 'moments';
let isGenerating = false;
let abortController = null;
let streamBuf = '';
let loadedOldest = null;    // 已加载窗口的最早时间戳
let hasMoreHistory = false;
let editingMessageId = null;
let objectUrlCache = new Map();
// A 组状态：长按菜单实例（懒创建，scrollContainer 是消息区，关闭时恢复滚动位置）。
let lpMenu = null;
// 多选：长按菜单「选择」攒起来的消息 id，批量删除 / 清除选择走顶栏 ··· 菜单。
let selectedMessageIds = new Set();
// 日常体验：草稿防抖保存器（按角色）、新消息 pill 计数、启动时一次性恢复阅读位置。
let draftSaver = null;
let newMessagesCount = 0;
let restoreReadPosOnce = false;
// 同毫秒连发时 IndexedDB 的 [charId, timestamp] 索引无法保证顺序，
// 新消息用单调递增时间戳（与预览里的 seq 索引同等效果；导入的旧消息
// 若时间戳相同，仍按原有顺序显示）。
let lastMsgTs = 0;
function nextTs() {
  const now = Date.now();
  lastMsgTs = Math.max(now, lastMsgTs + 1);
  return lastMsgTs;
}


const DEFAULT_AVATAR = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#a4a4a4"/><text x="32" y="42" font-size="28" text-anchor="middle" fill="white" font-family="Georgia" font-style="italic">n</text></svg>`);

/* ---------------- 基础工具 ---------------- */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}
function setSaveState(t) { $('#save-state').textContent = t || ''; }
function showModal(title, bodyHTML, actions) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHTML;
  const box = $('#modal-actions');
  box.innerHTML = '';
  (actions || [{ label: '关闭' }]).forEach((a) => {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.primary) b.className = 'primary';
    if (a.danger) b.className = 'danger';
    b.onclick = () => { hideModal(); a.onClick?.(); };
    box.appendChild(b);
  });
  $('#modal').classList.remove('hidden');
}
function hideModal() { $('#modal').classList.add('hidden'); }
function openSheet(id) { $(id).classList.remove('hidden'); }
function closeSheet(id) { $(id).classList.add('hidden'); }
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', (e) => e.target.closest('.sheet').classList.add('hidden')));
document.querySelectorAll('.sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s) s.classList.add('hidden'); }));
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') hideModal(); });

async function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
async function resolveAvatar(src) {
  if (!src) return DEFAULT_AVATAR;
  if (src.startsWith('attachment:')) {
    const att = await backend.get('attachments', src.slice('attachment:'.length));
    if (att?.blob) {
      if (!objectUrlCache.has(src)) objectUrlCache.set(src, URL.createObjectURL(att.blob));
      return objectUrlCache.get(src);
    }
    return DEFAULT_AVATAR;
  }
  return src;
}
async function attachmentDataURL(id) {
  const att = await backend.get('attachments', id);
  return att?.blob ? blobToDataURL(att.blob) : null;
}
async function saveAttachment(blob, name) {
  const id = uid('att');
  await backend.put('attachments', { id, blob, name: name || '', createdAt: Date.now() });
  return id;
}
async function compressImageFile(file, { quality = 0.8, maxSize = 1024 } = {}) {
  if (file.type === 'image/gif') return { dataUrl: await blobToDataURL(file), mime: file.type, blob: file };
  const dataUrl = await blobToDataURL(file);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  let { width, height } = img;
  const scale = Math.min(1, maxSize / Math.max(width, height));
  width = Math.round(width * scale); height = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  const out = canvas.toDataURL('image/jpeg', quality);
  const blob = await (await fetch(out)).blob();
  return { dataUrl: out, mime: 'image/jpeg', blob };
}

/* ---------------- 加载与种子数据 ---------------- */
async function loadAll() {
  const [chars, wbs, stks, settings] = await Promise.all([
    backend.getAll('characters'), backend.getAll('worldBooks'),
    backend.getAll('stickers'), backend.get('settings', 'api'),
  ]);
  worldBooks = wbs;
  stickers = stks;
  if (settings?.value) apiSettings = { ...apiSettings, ...settings.value };
  const presets = await backend.get('settings', 'apiPresets');
  if (presets?.value) apiPresets = presets.value;
  const sumApi = await backend.get('settings', 'summaryApi');
  if (sumApi?.value) summaryApi = { ...summaryApi, ...sumApi.value };
  const embApi = await backend.get('settings', 'embeddingApi');
  if (embApi?.value) embeddingApi = { ...embeddingApi, ...embApi.value };
  const sumSet = await backend.get('settings', 'summarySettings');
  if (sumSet?.value) summarySettings = { ...summarySettings, ...sumSet.value };
  const vecSet = await backend.get('settings', 'vectorSettings');
  if (vecSet?.value) vectorSettings = { ...DEFAULT_VECTOR_SETTINGS, ...vecSet.value };
  const assocSet = await backend.get('settings', 'assocSettings');
  if (assocSet?.value) assocSettings = { ...DEFAULT_ASSOC_SETTINGS, ...assocSet.value };
  const notifySet = await backend.get('settings', NOTIFY_SETTINGS_KEY);
  if (notifySet?.value) notifySettings = { ...DEFAULT_NOTIFY_SETTINGS, ...notifySet.value };
  const kaSet = await backend.get('settings', KEEPALIVE_SETTINGS_KEY);
  if (kaSet?.value) keepAliveSettings = { ...DEFAULT_KEEPALIVE_SETTINGS, ...kaSet.value };
  const pushSet = await backend.get('settings', PUSH_SETTINGS_KEY);
  if (pushSet?.value) pushSettings = { ...DEFAULT_PUSH_SETTINGS, ...pushSet.value };
  const iconSet = await backend.get('settings', CUSTOM_ICON_SETTINGS_KEY);
  if (iconSet?.value) customIconSettings = { appName: iconSet.value.appName || DEFAULT_APP_NAME, dataUrl: iconSet.value.dataUrl || null };
  // B 组：自定义图标启动对账。标题从设置恢复；再问服务端当前版本，
  // 以服务端为准同步 localStorage 与页面 link（为下次加载准备）。
  // 全程 try/catch：函数未上线（404）或离线时静默失败，降级为
  // /api/custom-icon 的 302 兜底，不阻塞页面。
  try {
    if (customIconSettings.appName && customIconSettings.appName !== DEFAULT_APP_NAME) {
      document.title = customIconSettings.appName;
    }
    const meta = await fetchCustomIconMeta();
    const serverVersion = meta?.version || null;
    let localVersion = null;
    try { localVersion = localStorage.getItem(CUSTOM_ICON_VERSION_KEY); } catch { /* 忽略 */ }
    if (serverVersion) {
      if (localVersion !== serverVersion) {
        try { localStorage.setItem(CUSTOM_ICON_VERSION_KEY, serverVersion); } catch { /* 忽略 */ }
        applyCustomIconUrl(buildCustomIconVersionedUrl(serverVersion));
      }
    } else if (localVersion) {
      // 服务端已没有自定义图标：本地版本已过期，清掉，走 302 兜底。
      try { localStorage.removeItem(CUSTOM_ICON_VERSION_KEY); } catch { /* 忽略 */ }
      applyCustomIconUrl('/api/custom-icon');
    }
  } catch { /* 服务端未上线/离线：走兜底 URL，不阻塞页面 */ }
  const wakeSet = await backend.get('settings', WAKE_SETTINGS_KEY);
  if (wakeSet?.value) wakeSettings = { ...DEFAULT_WAKE_SETTINGS, ...wakeSet.value };
  const vecProg = await backend.get('settings', 'vectorIndexProgress');
  if (vecProg?.value) vectorIndexProgress = vecProg.value;
  const memJobs = await backend.get('settings', 'memoryJobs');
  if (memJobs?.value) memoryJobs = memJobs.value;
  const cot = await backend.get('settings', 'cotSettings');
  if (cot?.value) globalSettings = { cotSettings: cot.value };
  const app = await backend.get('settings', 'appearance');
  if (app?.value) appearanceSettings = app.value;
  if (!chars.length) {
    char = await seedDemo();
    worldBooks = await backend.getAll('worldBooks');
    stickers = await backend.getAll('stickers');
  } else {
    const lastId = localStorage.getItem('uwu-chat.lastChar');
    char = chars.find((c) => c.id === lastId) || chars.find((c) => c._isMain) || chars[0];
  }
  await attachJournals(char);
  localStorage.setItem('uwu-chat.lastChar', char.id);
}

async function attachJournals(c) {
  const journals = (await backend.getAll('journals')).filter((j) => j.charId === c.id);
  c.memoryJournals = journals;
  return c;
}

function sampleStickerSVG(label, bg) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="24" fill="${bg}"/><text x="60" y="78" font-size="44" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`)}`;
}

async function seedDemo() {
  const demo = {
    id: 'char_demo', realName: 'Noah', myName: '我', remarkName: 'Noah',
    status: '在线', persona: '这是一个示例角色，用于在没有导入备份时预览聊天流程。请导入你的备份，或在设置里把名字、人设改成你自己的。',
    myPersona: '', worldBookIds: ['wb_demo_1'],
    stickerGroups: '日常', bilingualModeEnabled: true,
    replyCountMin: 3, replyCountMax: 8, replyCountEnabled: false, maxMemory: '80',
    exclusivePromptVersion: '', statusPanel: { enabled: false, promptSuffix: '', regexPattern: '', replacePattern: '', historyLimit: 3 },
    useRealGallery: false, gallery: [], isSample: true,
  };
  await backend.put('characters', demo);
  await backend.put('worldBooks', { id: 'wb_demo_1', title: '示例世界书', content: '示例背景：你们住在同一条街，经常一起散步。', position: 'before', depth: 1 });
  await backend.put('journals', { id: 'journal_demo_1', charId: 'char_demo', title: '示例记忆', content: '第一次见面是在雨天，共用一把伞。', isFavorited: true, timestamp: Date.now() });
  for (const [name, emoji, bg] of [['贴贴', '♥', '#e7e7e7'], ['哼', '·_·', '#dddddd']]) {
    const blob = await (await fetch(sampleStickerSVG(emoji, bg))).blob();
    const attId = await saveAttachment(blob, name);
    await backend.put('stickers', { id: uid('stk'), name, group: '日常', attachmentId: attId });
  }
  const now = Date.now();
  const welcome = [
    ['assistant', '今天也辛苦了。', -300000],
    ['assistant', '想和你一起，把时间过得慢一点。', -270000],
    ['user', '那就再待一会儿。', -180000],
    ['assistant', '好。哪儿也不去，就在这里陪你。', -120000],
  ].map(([role, text, offset]) => ({ id: uid('msg'), charId: 'char_demo', role, content: text,
    parts: [{ type: 'text', text }], timestamp: now + offset }));
  // 新安装的示例也包含双向引用，便于直接检查轮廓、方向及真实跳转；已有数据不受影响。
  welcome[3].quote = { messageId:welcome[2].id, senderId:'user_me', senderName:'我', content:welcome[2].content };
  welcome.push({ id:uid('msg'), charId:'char_demo', role:'user', content:'嗯，就这样。',
    parts:[{ type:'text', text:'嗯，就这样。' }], timestamp:now-60000,
    quote:{ messageId:welcome[1].id, senderId:'assistant', senderName:'Noah', content:welcome[1].content } });
  for (const m of welcome) await backend.put('messages', m);
  return demo;
}

async function saveCharacter() {
  const { memoryJournals, ...rest } = char;
  await backend.put('characters', rest);
  for (const j of memoryJournals || []) await backend.put('journals', { ...j, charId: char.id });
}
async function saveApiSettings() {
  await backend.put('settings', { key: 'api', value: apiSettings });
}
async function saveSummaryApi() {
  await backend.put('settings', { key: 'summaryApi', value: summaryApi });
}
async function saveEmbeddingApi() {
  await backend.put('settings', { key: 'embeddingApi', value: embeddingApi });
}
async function saveSummarySettings() {
  await backend.put('settings', { key: 'summarySettings', value: summarySettings });
}
async function saveVectorSettings() {
  await backend.put('settings', { key: 'vectorSettings', value: vectorSettings });
}
async function saveAssocSettings() {
  await backend.put('settings', { key: 'assocSettings', value: assocSettings });
}
async function saveNotifySettings() {
  await backend.put('settings', { key: NOTIFY_SETTINGS_KEY, value: notifySettings });
}
async function saveKeepAliveSettings() {
  await backend.put('settings', { key: KEEPALIVE_SETTINGS_KEY, value: keepAliveSettings });
}
async function savePushSettings() {
  await backend.put('settings', { key: PUSH_SETTINGS_KEY, value: pushSettings });
}
async function saveCustomIconSettings() {
  await backend.put('settings', { key: CUSTOM_ICON_SETTINGS_KEY, value: customIconSettings });
}
async function saveWakeSettings() {
  await backend.put('settings', { key: WAKE_SETTINGS_KEY, value: wakeSettings });
}
async function saveVectorIndexProgress(p) {
  vectorIndexProgress = p;
  await backend.put('settings', { key: 'vectorIndexProgress', value: p });
}

/* ---------------- 消息渲染 ---------------- */
function allowedStickerNames() {
  // 渲染/解析认的是“库里有没有这个名字”（原版兜底：分组内先找，全库再找），
  // 不是“在不在角色分组里”——分组只约束提示词（promptBuilder）。
  return knownStickerNames(stickers, char?.stickerGroups);
}
function findSticker(name) { return stickers.find((s) => s.name === name); }

/** 表情包取图（优先级 dataUrl > attachmentId > 原版 data 字段）；无图返回 null。 */
async function resolveStickerSrc(st) {
  const s = stickerImageSrc(st);
  if (!s) return null;
  if (s.kind === 'url') return s.src;
  return attachmentDataURL(s.id);
}

function protocolBody(content) {
  // 取 [X的消息：正文] 里的正文；双语返回原文+译文结构
  const m = String(content || '').match(/^\[.*?的消息[：:]([\s\S]*)\]$/);
  const inner = m ? m[1].trim() : String(content || '').trim();
  const bi = char?.bilingualModeEnabled ? parseBilingual(inner) : null;
  return { inner, bi };
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function renderTimeDivider(ts) {
  const d = el('div', 'time-divider', escapeHtml(formatTimeDivider(ts)));
  return d;
}

// 原始 UWU（chat_render.js:164/416）：状态更新、思考过程与隐藏指令
// （接收/退回转账、接收礼物）在非调试模式下不渲染。判定除了消息上的
// isStatusUpdate/isThinking 标记，也看内容本身——导入的旧数据可能只有
// 协议文本没有标记，单段状态协议或整条 <thinking> 同样算隐藏消息。
function isHiddenMessage(msg) {
  if (msg.isStatusUpdate || msg.isThinking) return true;
  const c = String(msg.content || '').trim();
  if (c.startsWith('<thinking>')) return true;
  const seg = classifyContent(msg.content || '', char, { allowedStickers: allowedStickerNames() });
  const segs = seg.kind === 'mixed' ? seg.segments : [seg];
  if (!segs.length) return false;
  return segs.every((s) =>
    s.kind === 'status' || s.kind === 'transferResponse' || s.kind === 'giftResponse'
    || (s.kind === 'html' && String(s.content || '').trim().toLowerCase().startsWith('<thinking>')));
}

/* ---------------- 长按菜单（A 组集成，js/longPressMenu.js） ----------------
 *  现行底部 sheet（openMsgMenu + #msg-menu）已退役：菜单改走浮动定位，
 *  跟随气泡位置自动选上下/左右展开，反应条独立排布在菜单与气泡之间。
 *  所有动作都真实生效（复制/引用/收藏/选择/编辑/撤回/重新生成/删除/反应），
 *  不给装饰按钮假功能；调试开关不在长按菜单里，改走顶栏 ··· 菜单。 */
function ensureLpMenu() {
  if (lpMenu) return lpMenu;
  lpMenu = new LongPressMenu({
    onCopy: (m) => copyMessageText(m),
    onQuote: (m) => startQuote(m),
    onFavorite: (m) => toggleFavoriteMessage(m),
    onSelect: (m) => toggleSelectMessage(m),
    onEdit: (m) => startEditMessage(m),
    onRecall: (m) => withdrawMessage(m),
    onRegenerate: () => handleRegenerate(),
    onDelete: (m, token) => deleteMessageWithUndo(m, token),
    onToggleContext: (m) => toggleMessageContext(m),
    onViewRaw: (m) => showModal('原始内容', `<pre class="code">${escapeHtml(JSON.stringify(m, null, 2))}</pre>`, [{ label: '关闭' }]),
    onReact: (next, emoji) => persistReaction(next, emoji),
    onMoreReactions: (m) => openMoreReactions(m),
    getBottomReserve: () => getBottomReserve(),
  }, { scrollContainer: messageArea });
  return lpMenu;
}

/** 底部避让高度：键盘高度（visualViewport 差值）+ 输入区 + Tab 栏。
 *  菜单底缘不进入这个区域，不被键盘和底栏遮挡。 */
function getBottomReserve() {
  let keyboard = 0;
  if (window.visualViewport && window.innerHeight > window.visualViewport.height) {
    keyboard = window.innerHeight - window.visualViewport.height;
  }
  const composerH = $('#composer')?.offsetHeight || 56;
  const tabbarH = $('#tabbar')?.offsetHeight || 62;
  return keyboard + composerH + tabbarH + 16;
}

function attachMsgMenu(wrap, msg) {
  ensureLpMenu().attachTo(wrap, msg);
}

/** 旧 openMsgMenu 的兼容入口：x/y 被 void 丢弃的历史问题已修掉，
 *  现在按气泡元素实际位置打开浮动菜单。 */
function openMsgMenu(msg, x, y) {
  const wrap = messageArea.querySelector(`[data-id="${CSS.escape(String(msg.id))}"]`);
  ensureLpMenu().open(msg, wrap || null, { x: x ?? 0, y: y ?? 0 });
}

async function copyMessageText(msg) {
  const text = msg.role === 'user' || msg.role === 'assistant'
    ? extractProtocolText(messageText(msg)) || msg.content : msg.content;
  try {
    await navigator.clipboard?.writeText(text);
    toast('已复制');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch { toast('复制失败'); }
    ta.remove();
  }
}

async function toggleFavoriteMessage(msg) {
  const m = await backend.get('messages', msg.id);
  if (!m) return;
  m.isFavorite = !m.isFavorite;
  await backend.put('messages', m);
  await renderMessages(false);
  toast(m.isFavorite ? '已收藏' : '已取消收藏');
}

function toggleSelectMessage(msg) {
  const wrap = messageArea.querySelector(`[data-id="${CSS.escape(String(msg.id))}"]`);
  if (selectedMessageIds.has(msg.id)) {
    selectedMessageIds.delete(msg.id);
    wrap?.classList.remove('selected');
  } else {
    selectedMessageIds.add(msg.id);
    wrap?.classList.add('selected');
  }
  toast(selectedMessageIds.size
    ? `已选 ${selectedMessageIds.size} 条，可在顶栏 ··· 菜单里批量删除或清除选择`
    : '已清除选择');
}

async function toggleMessageContext(msg) {
  const m = await backend.get('messages', msg.id);
  if (!m) return;
  m.isContextDisabled = !m.isContextDisabled;
  await backend.put('messages', m);
  await renderMessages(false);
  toast(m.isContextDisabled ? '已设为不进入上下文' : '已恢复进上下文');
}

/** 删除 + 5 秒撤销：token 只带恢复快照，不含 API 信息；过期后撤销入口失效。 */
async function deleteMessageWithUndo(msg, token) {
  const ids = selectedMessageIds.has(msg.id) && selectedMessageIds.size > 1
    ? [...selectedMessageIds] : [msg.id];
  const snapshots = [];
  for (const id of ids) {
    const m = await backend.get('messages', id);
    if (!m) continue;
    snapshots.push({ ...m });
    await backend.delete('messages', id);
    await invalidateExperiencesForSourceMessage(id);
  }
  selectedMessageIds.clear();
  await renderMessages(false);
  if (!snapshots.length) return;
  const undoToken = token && ids.length === 1 ? token : createDeleteToken(snapshots[0]);
  showUndoToast(snapshots.length > 1 ? `已删除 ${snapshots.length} 条消息` : '已删除', undoToken, snapshots);
}

function showUndoToast(text, token, snapshots) {
  const el = $('#toast');
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = `${text} · `;
  const btn = document.createElement('button');
  btn.textContent = '撤销';
  btn.className = 'mini-btn';
  btn.onclick = async () => {
    el.classList.add('hidden');
    clearTimeout(showUndoToast._t);
    for (const s of snapshots) await backend.put('messages', s);
    await renderMessages(false);
    toast('已恢复');
  };
  el.append(span, btn);
  el.classList.remove('hidden');
  clearTimeout(showUndoToast._t);
  showUndoToast._t = setTimeout(() => el.classList.add('hidden'), 5000);
  void token;
}

/** 表情反应：纯本地写回 IndexedDB（message.reactions），重复点取消，不请求模型。 */
async function persistReaction(nextMsg, emoji) {
  const current = await backend.get('messages', nextMsg.id);
  const base = current || nextMsg;
  const updated = toggleReaction(base, emoji);
  await backend.put('messages', updated);
  const wrap = messageArea.querySelector(`[data-id="${CSS.escape(String(nextMsg.id))}"]`);
  if (wrap) renderReactionsRow(wrap, updated);
}

function openMoreReactions(msg) {
  const extra = ['🎉', '😢', '🔥', '👀', '🙏', '💯'];
  showModal('更多反应', `<div class="reaction-more">${extra.map((e) => `<button data-emoji="${e}">${e}</button>`).join('')}</div>`, [{ label: '关闭' }]);
  document.querySelectorAll('.reaction-more button').forEach((b) => {
    b.addEventListener('click', async () => {
      hideModal();
      const current = await backend.get('messages', msg.id);
      if (!current) return;
      await persistReaction(toggleReaction(current, b.dataset.emoji), b.dataset.emoji);
    });
  });
}

/** 气泡下方的反应汇总行：有点过的表情才显示，mine 高亮。 */
function renderReactionsRow(wrap, msg) {
  let row = wrap.querySelector('.msg-reactions');
  const counts = reactionCounts(msg);
  if (!counts.length) { row?.remove(); return; }
  if (!row) {
    row = document.createElement('div');
    row.className = 'msg-reactions';
    wrap.querySelector('.msg-body')?.appendChild(row);
  }
  row.innerHTML = '';
  for (const c of counts) {
    const chip = document.createElement('button');
    chip.className = 'reaction-chip' + (c.mine ? ' mine' : '');
    chip.type = 'button';
    chip.textContent = c.count > 1 ? `${c.emoji} ${c.count}` : c.emoji;
    chip.title = c.mine ? '点一下取消我的反应' : '反应';
    chip.onclick = async () => {
      const current = await backend.get('messages', msg.id);
      if (!current) return;
      await persistReaction(toggleReaction(current, c.emoji), c.emoji);
    };
    row.appendChild(chip);
  }
}

/** 心声轻量面板：只在心声模式、点某条回复下的「心声」才打开，不自动弹出。 */
function openInnerVoicePanel(text) {
  const panel = $('#inner-voice-panel');
  $('#inner-voice-text').textContent = text || '';
  panel.classList.remove('hidden');
}

/** 发送失败重试：复用同一 messageId（put 而非 add），不产生重复记录。 */
async function retrySendMessage(messageId) {
  const m = await backend.get('messages', messageId);
  if (!m || !canRetry(m)) return;
  const next = retryMessage(m);
  try {
    await backend.put('messages', next);
    await renderMessages(false);
    toast('已重新发送');
  } catch (e) {
    toast('重试失败，请检查存储后导出备份');
  }
}

function createTextBubble(text) {
  const bubble = el('div', 'bubble message-bubble text-bubble');
  const content = el('span', 'bubble-text');
  content.textContent = String(text ?? '');
  bubble.appendChild(content);
  return bubble;
}

function createQuotedMessage(value, sourceMessage) {
  const ref = normalizeQuoteReference(value);
  const fromMe = ref.senderId === 'user_me' || ref.senderId === 'user';
  const q = el('button', `quote-bubble quoted-message ${fromMe ? 'from-me' : 'from-ai'}`);
  q.type = 'button';
  q.dataset.quoteMessageId = String(ref.messageId || '');
  q.dataset.sourceMessageId = String(sourceMessage.id || '');
  q.setAttribute('aria-label', `定位被引用消息：${ref.content.slice(0, 80)}`);
  const sender = el('span', 'quoted-sender');
  sender.textContent = ref.senderName || (fromMe ? char.myName : (char.remarkName || char.realName)) || '';
  const text = el('span', 'quote-text quoted-text quoted-content');
  text.textContent = ref.content || '原消息';
  q.append(sender, text);
  q.addEventListener('click', e => { e.stopPropagation(); jumpToQuotedMessage(ref, sourceMessage, q); });
  // A tap follows the reference; it must not start the parent's long-press timer.
  q.addEventListener('pointerdown', e => e.stopPropagation());
  return q;
}

// 引用定位的显示适配器（D2）：解析走 js/quoteNavigation.js，显示走现有的
// jumpToMessage；不含 historyWindowBefore 分页逻辑。返回 false 时
// followQuoteReference 判 reason 'hidden'。
async function showMessageTarget(target) {
  if (target.charId !== char.id || (isHiddenMessage(target) && !isDebugMode)) return false;
  return jumpToMessage(target.id, { returnTo: 'quote' });
}

let quoteNavigationBusy = false;
async function jumpToQuotedMessage(quote, source, button) {
  if (quoteNavigationBusy) return;
  quoteNavigationBusy = true;
  button?.classList.add('is-loading');
  button?.setAttribute('aria-busy', 'true');
  // 记下含引用那条消息与当前滚动位置，供“← 返回引用处”跳回并恢复。
  chatCenterState.quote = { sourceMessageId: source.id, scrollTop: messageArea.scrollTop };
  try {
    const result = await followQuoteReference({ backend, charId: char.id, quote, sourceMessage: source,
      getText: m => extractProtocolText(messageText(m)) || m.content,
      showTarget: showMessageTarget,
    });
    if (result.ok) {
      $('#chat-announcement').textContent = '已定位到被引用消息';
    } else {
      chatCenterState.quote = null;
      button?.classList.add('is-unavailable');
      toast(result.reason === 'ambiguous' ? '有多条相同原文，旧引用没有消息 ID，无法准确定位'
        : result.reason === 'withdrawn' ? '原消息已撤回或删除' : '原消息已不存在，或未包含在当前备份中');
    }
  } catch (e) { chatCenterState.quote = null; toast('定位失败，请稍后重试'); }
  finally { quoteNavigationBusy = false; button?.classList.remove('is-loading'); button?.removeAttribute('aria-busy'); }
}

async function createMessageElement(msg, isContinuous = false, isGroupLast = true) {
  // 非调试模式：隐藏消息直接不渲染（原版 chat_render.js:164 的 return null）。
  if (isHiddenMessage(msg) && !isDebugMode) return null;
  const wrap = el('div', `msg message-wrapper ${msg.role === 'user' ? 'sent' : 'received'}`);
  wrap.dataset.id = msg.id;
  wrap.dataset.messageId = msg.id;
  wrap.id = `message-${msg.id}`;
  wrap.dataset.role = msg.role;
  wrap.dataset.ts = String(msg.timestamp ?? 0);
  if (msg.isContextDisabled) wrap.classList.add('context-disabled');
  if (isContinuous) wrap.classList.add('continuous');
  // 组末判定与 .continuous 方向相反：continuous 标“非首条”，group-last 标
  // “组内最后一条”，iMessage 尾巴只出现在组末（chatDaily.js groupLastFlags）。
  if (isGroupLast) wrap.classList.add('group-last');
  if (msg.isWithdrawn) wrap.classList.add('withdrawn');
  if (msg.sendState) wrap.dataset.sendState = msg.sendState;
  if (selectedMessageIds.has(msg.id)) wrap.classList.add('selected');
  // 调试模式才走到这里：状态更新显示原始状态文本（原版调试模式下不剥协议），
  // 标上【调试可见】；完整卡片仍在状态栏弹窗里看。
  if (msg.isStatusUpdate) {
    wrap.classList.add('system-note', 'system-notification');
    wrap.appendChild(el('div', 'bubble message-bubble debug-visible', escapeHtml(msg.statusText || msg.content || '')));
    attachMsgMenu(wrap, msg);
    return wrap;
  }

  // 默认不在任何消息旁显示头像（分组首条也不显示）：iMessage 式无头像布局，
  // 气泡与分组本身承担信息层级；头像只留在顶栏 58px 圆头像里。

  // 心声解析（innerVoice.js）：助理文本入库/渲染前过 parseInnerVoice()，
  // 正文存 cleanContent，心声另存 msg.innerVoice；解析失败安静降级，
  // 协议标记绝不留在正文里。只处理文本字段，绝不读 reasoning/thinking。
  let renderMsg = msg;
  if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.includes('[inner_voice]')) {
    const parsed = parseInnerVoice(msg.content);
    if (parsed.innerVoice && !msg.innerVoice) msg.innerVoice = parsed.innerVoice;
    if (parsed.cleanContent !== msg.content) {
      renderMsg = {
        ...msg,
        content: parsed.cleanContent,
        parts: (msg.parts || []).map((p) => (p?.type === 'text' && typeof p.text === 'string'
          ? { ...p, text: parseInnerVoice(p.text).cleanContent } : p)),
      };
    }
  }
  const body = el('div', 'msg-body message-bubble-row');
  if (msg.quote) {
    wrap.classList.add('has-quote');
    wrap.dataset.quoteMessageId = String(normalizeQuoteReference(msg.quote).messageId || '');
    body.appendChild(createQuotedMessage(msg.quote, msg));
  }
  const contentEls = await renderMessageContent(renderMsg);
  for (const c of contentEls) body.appendChild(c);
  // 尾巴只挂在组末消息的最后一段内容上（CSS 只画 .group-last 的尾巴）：
  // 文字气泡/语音卡/转账/礼物卡直接挂；图片与表情包不挂尾巴（2026-11-21：
  // 透明底图片上尾巴会悬空在图外，见截图右下角）；
  // 旧版导入的引用协议（.quoted-reply 包装）挂其内层气泡。
  const finalContent = contentEls[contentEls.length - 1];
  const tailContent = finalContent?.matches('.bubble, .voice-card, .transfer-card, .gift-card') ? finalContent
    : finalContent?.matches('.quoted-reply') ? finalContent.querySelector('.bubble') : null;
  tailContent?.classList.add('message-tail');
  if (body.querySelectorAll('.quoted-message').length > 1) wrap.classList.add('multiple-quotes');
  if (body.querySelector('.quoted-message')) wrap.classList.add('has-quote');
  if (msg.mock) body.appendChild(el('span', 'mock-tag', '模拟回复'));
  if (msg.edited) body.appendChild(el('div', 'msg-meta', '已编辑'));
  if (msg.isFavorite) body.appendChild(el('div', 'msg-fav', '★ 已收藏'));
  // 心声只在心声模式露出入口：昵称附近小入口是这条回复下的「心声」按钮，
  // 点开轻量面板查看对应回合内容，不自动弹出，不常驻占高度。
  if (msg.role === 'assistant' && msg.innerVoice && getStatusMode(char) === 'inner') {
    const ivBtn = el('button', 'inner-voice-btn', '心声');
    ivBtn.type = 'button';
    ivBtn.onclick = () => openInnerVoicePanel(msg.innerVoice);
    body.appendChild(ivBtn);
  }
  // 发送失败：同一 messageId 的重试按钮（chatDaily.js retryMessage）。
  if (msg.sendState === 'failed') {
    const retryBtn = el('button', 'msg-retry', '发送失败 · 点此重试');
    retryBtn.type = 'button';
    retryBtn.onclick = () => retrySendMessage(msg.id);
    body.appendChild(retryBtn);
  }
  wrap.appendChild(body);
  // 表情反应汇总行（有点过的表情才显示）。
  if (Array.isArray(msg.reactions) && msg.reactions.length) renderReactionsRow(wrap, msg);

  attachMsgMenu(wrap, msg);
  return wrap;
}

async function renderMessageContent(msg) {
  const out = [];
  // 图片附件（用户发的图）：parts 里有 image 时优先渲染图片
  const parts = effectiveParts(msg);
  const imgPart = parts.find((p) => p.type === 'image');
  if (imgPart) {
    let src = imgPart.data || null;
    if (!src && imgPart.attachmentId) src = await attachmentDataURL(imgPart.attachmentId);
    if (src) {
      const img = el('img', 'photo-img');
      img.src = src;
      img.addEventListener('click', () => openImageViewer(src));
      const w = el('span', 'photo-wrap image-bubble');
      w.appendChild(img);
      out.push(w);
    }
    const textPart = parts.find((p) => p.type === 'text');
    if (textPart?.text && !textPart.text.includes('发来了一张图片')) {
      out.push(createTextBubble(textPart.text));
    }
    if (out.length) return out;
  }

  const seg = classifyContent(msg.content || '', char, { allowedStickers: allowedStickerNames() });
  const segs = seg.kind === 'mixed' ? seg.segments : [seg];
  for (const s of segs) {
    const node = await renderSegment(msg, s);
    if (node) out.push(node);
  }
  // 全是被隐藏的段（状态/思考/隐藏指令）时不补原始内容，避免协议文本漏进聊天流。
  if (!out.length && !isHiddenMessage(msg)) out.push(createTextBubble(msg.content || ''));
  return out;
}

async function renderSegment(msg, s) {
  switch (s.kind) {
    case 'bilingual': {
      // 译文在气泡内按正常文档流展开；原文减淡，避免长译文压住下一条消息。
      const b = el('div', 'bubble message-bubble text-bubble');
      const orig = el('span', 'bubble-text');
      orig.textContent = s.foreign;
      b.appendChild(orig);
      const t = el('span', 'translation translation-text', escapeHtml(s.chinese));
      const btn = el('button', 'toggle-t', '翻译');
      btn.onclick = () => {
        const shown = b.classList.toggle('show-translation'); t.classList.toggle('active', shown); btn.setAttribute('aria-expanded', String(shown));
        btn.textContent = shown ? '原文' : '翻译';
      };
      b.appendChild(t); b.appendChild(btn);
      return b;
    }
    case 'text': {
      const { inner, bi } = protocolBody(s.content);
      if (bi) {
        const b = el('div', 'bubble message-bubble text-bubble');
        const orig = el('span', 'bubble-text');
        orig.textContent = bi.foreign;
        b.appendChild(orig);
        const t = el('span', 'translation translation-text', escapeHtml(bi.chinese));
        const btn = el('button', 'toggle-t', '翻译');
        btn.onclick = () => { const shown = b.classList.toggle('show-translation'); t.classList.toggle('active', shown); btn.setAttribute('aria-expanded', String(shown)); btn.textContent = shown ? '原文' : '翻译'; };
        b.appendChild(t); b.appendChild(btn);
        return b;
      }
      // plain 可能是用户发的协议文本（[我的消息：…]）或导入的纯文本，
      // protocolBody 会剥掉协议外壳，只显示正文。
      return createTextBubble(inner);
    }
    case 'quote': {
      // 旧版导入的原始引用协议与结构化 quote 走同一条渲染 / 定位链路。
      const wrap = el('div', 'quoted-reply');
      if (!msg.quote) wrap.appendChild(createQuotedMessage({
        content: s.quoted, senderId: msg.role === 'user' ? 'assistant' : 'user_me',
      }, msg));
      const b = el('div', 'bubble message-bubble text-bubble');
      b.appendChild(el('span', 'bubble-text', escapeHtml(s.reply)));
      wrap.appendChild(b);
      return wrap;
    }
    case 'sticker': {
      const st = findSticker(s.name);
      const src = await resolveStickerSrc(st);
      if (src) {
        const img = el('img', 'sticker-img');
        img.src = src; img.alt = s.name;
        const w = el('span', 'sticker-wrap sticker-bubble');
        w.appendChild(img);
        return w;
      }
      return createTextBubble(`[表情包：${s.name}]`);
    }
    case 'stickerUnknown':
      return createTextBubble(`[表情包：${s.name}]（未找到该表情包）`);
    case 'photo': {
      const galleryHit = (char.gallery || []).find((g) => g.name === s.body);
      if (galleryHit?.url) {
        const img = el('img', 'photo-img');
        img.src = galleryHit.url;
        img.addEventListener('click', () => openImageViewer(galleryHit.url));
        const w = el('span', 'photo-wrap image-bubble');
        w.appendChild(img);
        return w;
      }
      const card = el('div', 'card pv-card');
      card.innerHTML = `<div class="card-title">照片 / 视频</div><div class="card-sub">${escapeHtml(s.body || '图片描述')}</div><div class="card-status">描述卡 · 非真实照片</div>`;
      return card;
    }
    case 'voice': {
      // 220×63 气泡：30px 播放按钮 + 波形条 + 时长；点播放/波形展开转写，
      // 气泡变两行（47px 播放行 + 转写文本行），同一个形状，不另起卡片。
      const dur = Math.max(1, Math.min(60, Math.ceil((s.body || '').length / 3.5)));
      const card = el('div', 'voice-card voice-bubble');
      const row = el('div', 'voice-row');
      const play = el('button', 'voice-play play-icon');
      play.setAttribute('aria-label', '展开语音文字');
      play.setAttribute('aria-expanded', 'false');
      play.innerHTML = '<svg class="icon"><use href="#i-play"></use></svg>';
      const wave = el('div', 'voice-wave');
      for (const h of [7, 12, 17, 10, 20, 14, 8, 18, 12, 21, 9, 15, 19, 11, 16, 8, 13, 10]) {
        const bar = el('i'); bar.style.height = h + 'px'; wave.appendChild(bar);
      }
      const durEl = el('span', 'voice-dur duration', escapeHtml(`${dur}″`));
      row.append(play, wave, durEl);
      const transcript = el('div', 'voice-transcript hidden', escapeHtml(s.body || ''));
      const toggleText = () => {
        const nowHidden = transcript.classList.toggle('hidden');
        card.classList.toggle('expanded', !nowHidden);
        transcript.classList.toggle('active', !nowHidden);
        play.setAttribute('aria-expanded', String(!nowHidden));
        play.setAttribute('aria-label', nowHidden ? '展开语音文字' : '收起语音文字');
      };
      play.onclick = toggleText;
      wave.onclick = toggleText;
      card.append(row, transcript);
      return card;
    }
    case 'status':
      // 混合消息里的状态段：非调试不显示（原版做法是把状态正则从气泡里剔掉）；
      // 调试模式显示原文，标【调试可见】。
      if (!isDebugMode) return null;
      return el('div', 'bubble message-bubble debug-visible', escapeHtml(s.body || ''));
    case 'withdraw':
      return createTextBubble(s.content);
    case 'transfer': {
      const m = s.content.match(/([0-9]+(?:\.[0-9]+)?)\s*元[；;]?\s*备注[：:](.*)/);
      const amount = m ? m[1] : '';
      const remark = m ? m[2].replace(/\]$/, '') : '';
      const card = el('div', 'card transfer-card');
      const statusText = msg.transferStatus === 'received' ? '已收款' : msg.transferStatus === 'returned' ? '已退回' : '待处理';
      card.innerHTML = `<div class="card-label">转账</div><div class="card-amount">${escapeHtml(amount ? `${amount} 元` : '转账')}</div>${remark ? `<div class="card-sub">备注：${escapeHtml(remark)}</div>` : ''}<div class="card-status">${statusText}</div>`;
      if (msg.role === 'assistant' && msg.transferStatus === 'pending') {
        const acts = el('div', 'card-actions');
        const ok = el('button', '', '接收');
        const no = el('button', '', '退回');
        ok.onclick = () => respondToTransfer(msg.id, 'received');
        no.onclick = () => respondToTransfer(msg.id, 'returned');
        acts.append(ok, no);
        card.appendChild(acts);
      }
      return card;
    }
    case 'gift': {
      const card = el('div', 'card gift-card');
      const statusText = msg.giftStatus === 'received' ? '已接收' : msg.giftStatus === 'sent' ? '已送出' : (msg.giftStatus || '');
      card.innerHTML = `<div class="card-label">礼物</div><div class="card-sub">${escapeHtml(s.body || '')}</div><div class="card-status">${statusText}</div>`;
      if (msg.role === 'assistant' && msg.giftStatus === 'sent') {
        const acts = el('div', 'card-actions');
        const ok = el('button', '', '接收礼物');
        ok.onclick = () => receiveGift(msg.id);
        acts.append(ok);
        card.appendChild(acts);
      }
      return card;
    }
    case 'html': {
      const raw = String(s.content || '');
      // <thinking> 块：思考过程，非调试不渲染（原版 chat_render.js:164/416）。
      if (raw.trim().toLowerCase().startsWith('<thinking>')) {
        if (!isDebugMode) return null;
        return el('div', 'bubble message-bubble debug-visible', escapeHtml(raw));
      }
      // 真实 HTML 模板：先做变量匹配——与状态栏同一套 substituteTemplateVars、
      // 同一份角色上下文（statusTemplateCtx）——再放进沙箱 iframe 隔离渲染，
      // 绝不直接 innerHTML 进主页面（与状态栏同一条隔离规则）。
      const substituted = substituteTemplateVars(raw, statusTemplateCtx(char));
      const frameId = `chat-html-${++chatHtmlSeq}`;
      const frame = document.createElement('iframe');
      frame.className = 'html-card-frame html-bubble';
      frame.dataset.chatFrame = frameId;
      frame.title = 'HTML 卡片';
      frame.setAttribute('sandbox', 'allow-scripts allow-popups');
      frame.setAttribute('scrolling', 'no');
      frame.style.height = '120px';
      frame.srcdoc = buildStatusDocument(substituted, { marker: `chat ${msg.id} ${frameId}`, frameId });
      return frame;
    }
    case 'forward': {
      const card = el('div', 'card placeholder-card');
      card.innerHTML = `<div class="card-title">转发的聊天记录（占位）</div><details><summary>查看原始内容</summary><div class="card-sub">${escapeHtml(s.content)}</div></details>`;
      return card;
    }
    case 'transferResponse':
    case 'giftResponse':
      return null; // 隐藏指令不显示气泡
    default:
      return createTextBubble(s.content);
  }
}

function openImageViewer(src) {
  showModal('图片', `<img src="${escapeHtml(src)}" style="max-width:100%;border-radius:10px">`, [{ label: '关闭' }]);
}

/** 新消息到达时的滚动：贴在底部才跟随拉底；上翻看历史时不强行拉底，
 *  改显示“有新消息”入口（chatDaily.js decideNewMessageDisplay）。 */
function scrollToBottomIfNear(force = false) {
  const d = distanceFromBottom(messageArea);
  if (force || decideNewMessageDisplay({ distanceFromBottom: d }).shouldStickToBottom) {
    messageArea.scrollTop = messageArea.scrollHeight;
    hideNewMessagesPill();
    return true;
  }
  return false;
}

function showNewMessagesPill() {
  newMessagesCount += 1;
  const pill = $('#new-msg-pill');
  pill.textContent = `↓ 有 ${newMessagesCount} 条新消息`;
  pill.classList.remove('hidden');
}

function hideNewMessagesPill() {
  newMessagesCount = 0;
  $('#new-msg-pill')?.classList.add('hidden');
}

/** 已送达：只在末条已发送消息下方显示一次（已送达 + 时间，10px）。
 *  每次重渲染/追加后重算，旧标记先清掉，全流只有一处。 */
function refreshDeliveredMarker() {
  messageArea.querySelectorAll('.msg-delivered').forEach((n) => n.remove());
  const sent = [...messageArea.querySelectorAll('.msg.sent:not(.withdrawn)')];
  const last = sent[sent.length - 1];
  if (!last) return;
  const body = last.querySelector('.msg-body');
  if (!body) return;
  const ts = Number(last.dataset.ts || 0);
  body.appendChild(el('div', 'msg-delivered', `已送达 · ${escapeHtml(formatTimeDivider(ts || Date.now()))}`));
}

async function renderMessages(isLoadMore = false) {
  // 全量重渲染前记下距底偏移：用户上翻看历史时，重渲染也不强行拉到底。
  const distBefore = isLoadMore ? 0 : distanceFromBottom(messageArea);
  const savedPos = !isLoadMore && restoreReadPosOnce ? loadReadingPosition(localStorage, char.id) : null;
  if (!isLoadMore) {
    messageArea.innerHTML = '';
    loadedOldest = null;
  }
  const oldHeight = messageArea.scrollHeight;
  const { messages, hasMore, oldestTimestamp } = await backend.getMessagesPage(char.id, {
    before: isLoadMore ? loadedOldest : Infinity, limit: PAGE_SIZE,
  });
  hasMoreHistory = hasMore;
  if (messages.length) loadedOldest = messages[0].timestamp;
  const frag = document.createDocumentFragment();
  let lastTime = 0;
  const lastFlags = groupLastFlags(messages);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const prev = i > 0 ? messages[i - 1] : null;
    if (!prev || m.timestamp - prev.timestamp > 10 * 60 * 1000 || new Date(m.timestamp).toDateString() !== new Date(prev.timestamp).toDateString()) {
      frag.appendChild(renderTimeDivider(m.timestamp));
    }
    const continuous = !!prev && prev.role === m.role && m.timestamp - prev.timestamp < 10 * 60 * 1000;
    const node = await createMessageElement(m, continuous, lastFlags[i]);
    if (node) frag.appendChild(node);
    lastTime = m.timestamp;
  }
  void lastTime;
  if (isLoadMore) {
    messageArea.prepend(frag);
    messageArea.scrollTop = messageArea.scrollHeight - oldHeight;
  } else {
    messageArea.appendChild(frag);
    if (restoreReadPosOnce && savedPos && savedPos.distanceFromBottom > 48) {
      // 启动时一次性恢复阅读位置：按保存的距底偏移还原，不拉到底。
      restoreReadPosOnce = false;
      messageArea.scrollTop = Math.max(0, messageArea.scrollHeight - messageArea.clientHeight - savedPos.distanceFromBottom);
    } else if (restoreReadPosOnce) {
      restoreReadPosOnce = false;
      messageArea.scrollTop = messageArea.scrollHeight;
    } else if (distBefore <= 48) {
      messageArea.scrollTop = messageArea.scrollHeight;
    } else {
      messageArea.scrollTop = Math.max(0, messageArea.scrollHeight - messageArea.clientHeight - distBefore);
    }
  }
  const oldBtn = $('#load-more-btn');
  if (oldBtn) oldBtn.remove();
  if (hasMoreHistory) {
    const btn = el('button', 'load-more', '加载更早的消息');
    btn.id = 'load-more-btn';
    btn.onclick = () => renderMessages(true);
    messageArea.prepend(btn);
  }
  refreshDeliveredMarker();
}

async function appendMessageElement(msg, opts = {}) {
  const distBefore = distanceFromBottom(messageArea);
  const count = await backend.countMessages(char.id);
  void count;
  const all = await backend.getMessagesPage(char.id, { before: msg.timestamp + 1, limit: 2 });
  const prev = all.messages.find((m) => m.id !== msg.id);
  const continuous = !!prev && prev.role === msg.role && msg.timestamp - prev.timestamp < 10 * 60 * 1000;
  const node = await createMessageElement(msg, continuous, true);
  if (node) {
    // 新消息是组末：上一条同组消息的尾巴要收掉（它不再是组末）。
    const lastWrap = messageArea.querySelector('.msg:last-child');
    if (lastWrap && prev && lastWrap.dataset.id === prev.id && lastWrap.dataset.role === msg.role) {
      lastWrap.classList.remove('group-last');
    }
    // 拉底判定用追加前的距底偏移：追加后距离会变大，不能事后量。
    const shouldStick = opts.forceStick
      || decideNewMessageDisplay({ distanceFromBottom: distBefore }).shouldStickToBottom;
    messageArea.appendChild(node);
    if (shouldStick) {
      messageArea.scrollTop = messageArea.scrollHeight;
      hideNewMessagesPill();
    } else {
      showNewMessagesPill();
    }
    refreshDeliveredMarker();
  }
}

function updateHeader() {
  $('#char-name').textContent = char.remarkName || char.realName || '角色';
  resolveAvatar(char.avatar).then((src) => { $('#char-avatar').src = src; ManageView.refreshHome(src); });
  $('#mock-badge').classList.toggle('hidden', !!apiSettings.key);
  $('#mock-badge').textContent = apiSettings.key ? '' : '模拟';
  $('#mock-badge').title = apiSettings.key ? '' : MOCK_BADGE;
  $('#auto-reply-toggle').checked = localStorage.getItem('uwu-chat.autoReply') === '1';
  renderStatusStrip();
}

// 状态条 chips：只放简短纯文本摘要（顶栏短状态 + 自定义状态原文摘要），
// 绝不把整段协议文本、HTML 或 CSS 放进 chip。防御一道：summarizeStatus
// 只剥带冒号的协议头，无冒号的「[xxx] …」协议头在这里再剥一次（截图里
// 曾出现 `[ 【public_post】 current h…` 漏进 chip）。
function stripProtocolHead(s) {
  let out = String(s || '').trim();
  // [xxx] / 【xxx】 形协议头整段去掉；截图实测的残留形是以 “[ ” 开头、
  // 后跟 【xxx】 的无闭合协议头（summarizeStatus 只剥带冒号的头，漏了它）。
  out = out.replace(/^\s*\[[^\]\n]{0,40}\]\s*/g, '');
  out = out.replace(/^\s*【[^】\n]{0,40}】\s*/g, '');
  out = out.replace(/^\s*\[+\s*【[^】\n]{0,40}】\s*/g, '');
  return out.trim();
}

function renderStatusStrip() {
  const strip = $('#status-strip');
  if (!strip) return;
  const items = [];
  if (char.status) items.push(summarizeStatus(char.status));
  const sp = char.statusPanel || {};
  if (sp.currentStatusRaw) items.push(summarizeStatus(sp.currentStatusRaw));
  if (sp.history?.length && sp.history[0].raw && sp.history[0].raw !== sp.currentStatusRaw) items.push(summarizeStatus(sp.history[0].raw));
  const uniq = [...new Set(items.map(stripProtocolHead))].filter(Boolean);
  $('#status-chips').innerHTML = uniq.length
    ? uniq.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('')
    : '<span class="chip">在线</span>';
}

/* ---------------- 发送与 AI 回复 ---------------- */
function userProtocolText(text) {
  return `[${char.myName || '我'}的消息：${text}]`;
}

async function sendUserText(text, opts = {}) {
  const content = userProtocolText(text);
  const msg = {
    id: uid('msg'), charId: char.id, role: 'user', content,
    parts: [{ type: 'text', text: content }],
    timestamp: nextTs(),
  };
  if (currentQuote) {
    msg.quote = { messageId: currentQuote.messageId, senderId: currentQuote.senderId || 'assistant', senderName: currentQuote.senderName, content: currentQuote.content };
    clearQuote();
  }
  if (opts.extraParts) msg.parts = [...msg.parts, ...opts.extraParts];
  if (opts.kind) msg.kind = opts.kind;
  try {
    await backend.put('messages', msg);
    await appendMessageElement(msg, { forceStick: true });
    // B 组：唤醒分类用用户原文（msg.content 包了协议前缀，分类必须用原文）；失败静默。
    if (wakeEngine) await wakeEngine.userMessage(char.id, msg.id, text).catch(() => {});
    wakeEngine?.setUserTyping(false);
    setSaveState('已保存');
  } catch (e) {
    // 发送失败：消息以 sendState='failed' 落盘并显示重试按钮，
    // 复用同一 messageId（chatDaily.js retryMessage），不产生重复记录。
    const failed = markFailed(msg, e);
    try { await backend.put('messages', failed); } catch { /* 已弹过保存失败提示 */ }
    await appendMessageElement(failed, { forceStick: true });
  }
  return msg;
}

async function sendImageMessage(file) {
  const { blob } = await compressImageFile(file);
  const attId = await saveAttachment(blob, file.name);
  const textPrompt = `[${char.myName || '我'}发来了一张图片：]`;
  const msg = {
    id: uid('msg'), charId: char.id, role: 'user',
    content: textPrompt, parts: [{ type: 'text', text: textPrompt }, { type: 'image', attachmentId: attId }],
    timestamp: nextTs(),
  };
  try {
    await backend.put('messages', msg);
    await appendMessageElement(msg, { forceStick: true });
    setSaveState('已保存');
  } catch (e) {
    const failed = markFailed(msg, e);
    try { await backend.put('messages', failed); } catch { /* 已弹过保存失败提示 */ }
    await appendMessageElement(failed, { forceStick: true });
  }
}

async function hydrateForRequest(slice) {
  // 请求副本：把 attachmentId 解析成 dataURL（仅本次请求所需的数据）
  const out = [];
  for (const m of slice) {
    const copy = { ...m };
    const parts = (m.parts || []).map((p) => ({ ...p }));
    for (const p of parts) {
      if (p.type === 'image' && p.attachmentId && !p.data) {
        p.data = await attachmentDataURL(p.attachmentId);
      }
    }
    if (parts.length) copy.parts = parts;
    out.push(copy);
  }
  return out;
}

/* ---------------- 向量记忆：索引与聊天召回 ---------------- */
// 当前向量配置对应的索引空间键。维度只有调一次接口才知道：
// 已缓存（同一 baseUrl+模型）时直接用；否则先发一次最小的 embeddings 探测
// （「测试向量」一个短文本），拿到维度后缓存到 vectorSettings。
async function getVectorSpaceKey() {
  const dimsFor = `${embeddingApi.url || ''}|${embeddingApi.model || ''}`;
  if (vectorSettings.dimensions && vectorSettings.dimensionsFor === dimsFor) {
    return spaceKeyFor({ baseUrl: embeddingApi.url, model: embeddingApi.model, dimensions: vectorSettings.dimensions });
  }
  const { dimensions } = await callEmbeddings(embeddingApi, ['测试向量']);
  if (!dimensions) throw new Error('向量接口没有返回维度。');
  vectorSettings.dimensions = dimensions;
  vectorSettings.dimensionsFor = dimsFor;
  await saveVectorSettings();
  return spaceKeyFor({ baseUrl: embeddingApi.url, model: embeddingApi.model, dimensions });
}

function vecProgressText(p) {
  if (!p) return '尚未建立索引。';
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const state = p.status === 'done' ? '已完成' : p.status === 'paused' ? '已暂停' : p.status === 'error' ? '出错' : '进行中';
  return `已索引 ${p.done}/${p.total} 段（${pct}% · ${state}）${p.error ? `：${p.error}` : ''}`;
}

/** 当前角色 + 当前向量配置对应的索引空间键；维度未知时返回 null（空间未确定）。 */
function currentVectorSpaceKey() {
  const dimsFor = `${embeddingApi.url || ''}|${embeddingApi.model || ''}`;
  return (vectorSettings.dimensions && vectorSettings.dimensionsFor === dimsFor)
    ? spaceKeyFor({ baseUrl: embeddingApi.url, model: embeddingApi.model, dimensions: vectorSettings.dimensions })
    : null;
}

/**
 * 按角色 + 空间隔离的索引进度文案：进度按 charId + spaceKey 存（indexDocuments 写入时
 * 就带这两个字段），这里只显示与当前角色、当前空间相符的进度；换角色 / 换模型后
 * 旧进度不再显示，避免把别的角色 / 空间留下的旧进度当成当前的。
 * 没有对应进度时显示「尚未建立索引。」；缺 charId / spaceKey 字段的旧记录无法
 * 判定归属，按以前的样子原样显示（现行写入都带这两个字段）。
 */
function vecProgressTextForCurrent(p) {
  if (!p) return '尚未建立索引。';
  if (p.charId && p.charId !== char?.id) return '尚未建立索引。';
  const spaceKey = currentVectorSpaceKey();
  if (p.spaceKey && spaceKey && p.spaceKey !== spaceKey) return '尚未建立索引。';
  if (p.spaceKey && !spaceKey) return '尚未建立索引。';
  return vecProgressText(p);
}

/** 建索引 / 补齐缺失 / 重建索引（rebuild=true 时先清空当前空间）。暂停靠取消标记，进度已存。
 * 记忆 + 经历一起进向量索引；关键词索引同时全量重建（纯本地，无网络请求）。 */
async function runVectorIndex({ rebuild = false } = {}) {
  if (vectorIndexRunning) { toast('索引正在进行中'); return; }
  if (!embeddingApi.url || !embeddingApi.key || !embeddingApi.model) {
    toast('请先在「API 设置 → 向量 Embedding API」里填写 Base URL、Key 和模型');
    return;
  }
  vectorIndexRunning = true;
  vectorIndexCancel = { cancelled: false };
  try {
    const spaceKey = await getVectorSpaceKey();
    if (rebuild) await deleteSpaceIndex(backend, char.id, spaceKey);
    const experiences = await getExperiencesForChar(backend, char.id);
    await rebuildKeywordIndexForChar(backend, char.id, char.memoryJournals || [], experiences);
    const res = await indexDocuments({
      backend, charId: char.id,
      documents: [...(char.memoryJournals || []), ...experiences], spaceKey,
      embedTexts: (texts) => callEmbeddings(embeddingApi, texts),
      signal: vectorIndexCancel,
      onProgress: (p) => { const elp = document.getElementById('vec-progress'); if (elp) elp.textContent = vecProgressText(p); },
      saveProgress: saveVectorIndexProgress,
    });
    if (res.cancelled) toast('索引已暂停，进度已保存，可点「继续建立索引」接着做');
    else toast(res.embedded ? `索引完成：新增 ${res.embedded} 段向量，共 ${res.total} 段` : `索引已是最新：共 ${res.total} 段，无需新增`);
  } catch (e) {
    toast(`建立索引失败：${e?.message || '未知错误'}`);
  } finally {
    vectorIndexRunning = false;
    vectorIndexCancel = null;
    await refreshVectorStatusUI();
  }
}

/**
 * 单条记忆 / 经历编辑 / 新总结生成后，后台更新它自己的索引（失败只记日志，不打扰聊天）。
 * 关键词索引一定更新（纯本地）；向量索引只在已配置向量 API 且不在全量建索引时更新。
 * 不参与检索的文档在这里只清不建（syncDocumentIndexes 内部处理）。
 */
function scheduleReindexDocument(doc) {
  if (!doc) return;
  if (vectorIndexRunning) return; // 全量索引进行中时由它一并处理
  void (async () => {
    try {
      let spaceKey = null;
      let embedTexts = null;
      if (vectorSettings.enabled && embeddingApi.url && embeddingApi.key && embeddingApi.model) {
        spaceKey = await getVectorSpaceKey();
        embedTexts = (texts) => callEmbeddings(embeddingApi, texts);
      }
      await syncDocumentIndexes({
        backend, charId: char.id, doc, spaceKey, embedTexts,
        saveProgress: saveVectorIndexProgress,
      });
    } catch (e) { console.warn('检索索引更新失败（聊天不受影响）：', e); }
  })();
}

/**
 * 经历写入/更新成功后，后台为它生成联想线索（走总结副 API，不用主 API）。
 * 生成失败不阻断保存、静默跳过，经历本身仍可用；未配置副 API 时不跑。
 * 线索写进经历记录的 clues 字段（不 bump version，见 associative.js）。
 */
function scheduleClueGeneration(exp) {
  if (!exp) return;
  void (async () => {
    try {
      await generateCluesForExperience(backend, exp, { summaryApi });
    } catch (e) { console.warn('联想线索生成失败（经历本身仍可用）：', e); }
  })();
}

/* ---------------- 批量任务队列（第 4 波） ---------------- */
// 任务记录存在 settings 'memoryJobs'（{jobId: job}）；一次只跑一个任务；
// 暂停靠取消标记，进度已存；页面关闭后 running 的任务回来显示“已暂停”
// （renderMemoryJobsUI 里转换，绝不假装仍在后台运行）；任务不开机自动跑。

/** 渲染记忆页的任务列表（当前角色的任务；上次 running 的改成已暂停）。 */
async function renderMemoryJobsUI() {
  const box = document.getElementById('memory-jobs');
  if (!box) return;
  // 正在跑的那个任务除外：它确实在跑，不能在进度回调里把它改成已暂停。
  const others = Object.fromEntries(Object.entries(memoryJobs).filter(([id]) => id !== memoryJobRunning));
  const { jobs: fixed, changed } = markInterruptedJobsPaused(others);
  if (changed) {
    memoryJobs = { ...memoryJobs, ...fixed };
    await saveMemoryJobs(backend, memoryJobs);
  }
  const list = Object.values(memoryJobs).filter((j) => j.charId === char.id)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!list.length) {
    box.innerHTML = '<p class="muted">还没有批量任务。任务只在你点开始后才跑，可暂停/恢复，进度保存在本机。</p>';
    return;
  }
  box.innerHTML = list.map((j) => `
    <div class="list-item"><strong>${esc(MEMORY_JOB_LABELS[j.kind] || j.kind)}</strong>
    <span class="muted">${esc(memoryJobStatusText(j))}</span>
    ${j.note ? `<p class="muted">${esc(j.note)}</p>` : ''}
    <div class="actions-row">
      ${(j.status === 'paused' || j.status === 'pending' || j.status === 'error')
        ? `<button data-job-resume="${j.id}" ${memoryJobRunning ? 'disabled' : ''}>继续</button>` : ''}
      ${j.status === 'running' ? `<button data-job-pause="${j.id}">暂停</button>` : ''}
    </div></div>`).join('');
  box.querySelectorAll('[data-job-resume]').forEach((b) => b.addEventListener('click', () => {
    const job = memoryJobs[b.dataset.jobResume];
    if (job) startMemoryJob(job.kind, job.id);
  }));
  box.querySelectorAll('[data-job-pause]').forEach((b) => b.addEventListener('click', () => {
    if (memoryJobCancel) { memoryJobCancel.cancelled = true; toast('正在暂停任务…'); }
  }));
}

/** 开始/继续一个批量任务（kind + 可选 jobId；不传 jobId 时恢复同种未完成的任务）。 */
async function startMemoryJob(kind, jobId = null) {
  if (memoryJobRunning) { toast('已有批量任务在进行中'); return; }
  const job = (jobId && memoryJobs[jobId])
    || Object.values(memoryJobs).find((j) => j.kind === kind && j.charId === char.id
      && (j.status === 'paused' || j.status === 'pending' || j.status === 'error'))
    || createMemoryJob(kind, char.id);
  if (!memoryJobs[job.id]) {
    memoryJobs[job.id] = job;
    await saveMemoryJobs(backend, memoryJobs);
  }
  memoryJobRunning = job.id;
  memoryJobCancel = { cancelled: false };
  try {
    if (kind === 'extract-all') await runExtractAllJob(job, memoryJobCancel);
    else if (kind === 'backfill-clues') await runBackfillCluesJob(job, memoryJobCancel);
    else if (kind === 'rebuild-keyword') await runRebuildKeywordJob(job, memoryJobCancel);
    else if (kind === 'rebuild-vector') await runRebuildVectorJob(job, memoryJobCancel);
    memoryJobs = await loadMemoryJobs(backend);
    renderMemoryJobsUI();
    await refreshVectorStatusUI();
    if (job.status === 'done') toast(`批量任务完成：${MEMORY_JOB_LABELS[kind]}`);
    else if (job.status === 'paused') toast('任务已暂停，进度已保存，可继续');
  } catch (e) {
    toast(`批量任务失败：${e?.message || '未知错误'}`);
  } finally {
    memoryJobRunning = null;
    memoryJobCancel = null;
    renderMemoryJobsUI();
  }
}

/** 为全部历史提取经历：未总结的消息按 40 条一批，逐批调总结副 API 提取。 */
async function runExtractAllJob(job, signal) {
  if (!summaryApi.url || !summaryApi.key || !summaryApi.model) {
    job.status = 'error';
    job.error = '未配置记忆总结副 API';
    await persistMemoryJob(backend, job);
    toast('请先在「API 设置 → 记忆总结副 API」里填写 Base URL、Key 和模型');
    return;
  }
  const history = await backend.getAllMessages(char.id);
  const rest = unsummarizedMessages(history, summarySettings.lastSummarizedMessageId);
  const batches = [];
  for (let i = 0; i < rest.length; i += 40) batches.push(rest.slice(i, i + 40));
  job.phase = '提取经历';
  await runMemoryJob({
    backend, job, items: batches, signal,
    processItem: async (batch) => {
      const res = await extractExperiencesFromRange(backend, char, batch, { summaryApi });
      for (const rec of res.created) { scheduleReindexDocument(rec); scheduleClueGeneration(rec); }
      if (!res.created.length && res.skipped.length) return 'skip';
      return 'ok';
    },
    onProgress: () => renderMemoryJobsUI(),
  });
}

/** 为旧经历补线索：无线索或线索已过期（version 不符）的经历，逐件调总结副 API
 * 生成；单件失败只计 failed，不阻断整批。线索生成不计联想预算。 */
async function runBackfillCluesJob(job, signal) {
  if (!summaryApi.url || !summaryApi.key || !summaryApi.model) {
    job.status = 'error';
    job.error = '未配置记忆总结副 API';
    await persistMemoryJob(backend, job);
    toast('请先在「API 设置 → 记忆总结副 API」里填写 Base URL、Key 和模型');
    return;
  }
  const exps = await getExperiencesForChar(backend, char.id);
  const todo = exps.filter(experienceNeedsClues);
  job.phase = '补线索';
  await runMemoryJob({
    backend, job, items: todo, signal,
    processItem: async (exp) => {
      const res = await generateCluesForExperience(backend, exp, { summaryApi });
      return res.skipped ? 'skip' : 'ok';
    },
    onProgress: () => renderMemoryJobsUI(),
  });
}

/** 重建关键词索引：Worker（建不出时主线程分片回退）算倒排，再分片写库。
 * 全新开始时先清空该角色旧索引；恢复写阶段时不清已写好的行、不重写。 */
async function runRebuildKeywordJob(job, signal) {
  const journals = char.memoryJournals || [];
  const experiences = await getExperiencesForChar(backend, char.id);
  const docs = retrievalDocsForChar(journals, experiences).filter(retrievalDocRetrievable);
  job.phase = '算倒排';
  let postings = memoryJobScratch.get(job.id);
  if (!postings) {
    const { result, mode } = await executeRetrievalTask('build-keyword-postings', {
      docs: docs.map((d) => ({ docId: d.docId, docKind: d.docKind, text: d.text })),
    }, {
      onProgress: (p) => {
        job.mode = p.mode;
        job.phase = '算倒排';
        renderMemoryJobsUI();
      },
    });
    postings = result.postings;
    job.mode = mode;
    memoryJobScratch.set(job.id, postings);
  }
  if (job.done === 0 && !job._cleared) {
    await buildKeywordIndex(backend, char.id, []);
    job._cleared = true;
  }
  job.phase = '写索引';
  await runMemoryJob({
    backend, job, items: postings, signal, sliceSize: 20,
    processItem: async (row) => {
      await backend.put('keywordIndex', {
        id: `${char.id}:${row.term}`, charId: char.id, term: row.term, postings: row.postings,
      });
      return 'ok';
    },
    onProgress: () => renderMemoryJobsUI(),
  });
  memoryJobScratch.delete(job.id);
}

/** 重建向量索引：复用 indexDocuments（按 hash 复用已有向量段，暂停后恢复不重算）。
 * 全新开始时先清空当前空间；恢复时不清。暂停靠 signal，进度双写
 * vectorIndexProgress 与任务记录。 */
async function runRebuildVectorJob(job, signal) {
  if (!embeddingApi.url || !embeddingApi.key || !embeddingApi.model) {
    job.status = 'error';
    job.error = '未配置向量 Embedding API';
    await persistMemoryJob(backend, job);
    toast('请先在「API 设置 → 向量 Embedding API」里填写 Base URL、Key 和模型');
    return;
  }
  job.phase = '建向量索引';
  job.status = 'running';
  const fresh = job.done === 0;
  try {
    const spaceKey = await getVectorSpaceKey();
    if (fresh) await deleteSpaceIndex(backend, char.id, spaceKey);
    const experiences = await getExperiencesForChar(backend, char.id);
    const res = await indexDocuments({
      backend, charId: char.id,
      documents: [...(char.memoryJournals || []), ...experiences], spaceKey,
      embedTexts: (texts) => callEmbeddings(embeddingApi, texts),
      signal,
      onProgress: (p) => {
        job.done = p.done;
        job.total = p.total;
        job.phase = '建向量索引';
        renderMemoryJobsUI();
      },
      saveProgress: async (p) => {
        await saveVectorIndexProgress(p);
        job.done = p.done;
        job.total = p.total;
        job.status = p.status === 'paused' ? 'paused' : p.status === 'done' ? 'done' : 'running';
        await persistMemoryJob(backend, job);
      },
    });
    job.failed = res.failed || 0;
    if (res.cancelled) job.status = 'paused';
    else { job.status = 'done'; job.done = res.total; job.total = res.total; }
    await persistMemoryJob(backend, job);
  } catch (e) {
    job.status = 'error';
    job.error = e?.message || String(e);
    await persistMemoryJob(backend, job);
    throw e;
  }
}

/** 记忆页「测试召回」：与聊天同一条融合检索（fusedRetrieve），记忆 + 经历
 * 都测——只传 journalsById 的旧写法会滤掉全部经历段（retrieveVectorCandidates
 * 按 documentsById 判定可检索性，经历不在表里就进不来）。向量阈值用聊天
 * 当前设置（vectorSettings.threshold），关键词路不设阈值；返回 fused
 * results（带 docKind / sourceStatus / 融合分 / 向量相关度 vectorScore），
 * 由调用方按 docKind 标明是记忆还是经历。 */
async function testRecall(queryText) {
  const { vectors, dimensions } = await callEmbeddings(embeddingApi, [queryText]);
  if (!vectors?.[0]) throw new Error('向量接口没有返回向量。');
  const spaceKey = spaceKeyFor({ baseUrl: embeddingApi.url, model: embeddingApi.model, dimensions });
  const journals = char.memoryJournals || [];
  const experiences = await getExperiencesForChar(backend, char.id).catch(() => []);
  const fused = await fusedRetrieve(backend, char, queryText, vectors[0], {
    spaceKey, journals, experiences,
    topN: 5, threshold: vectorSettings.threshold ?? DEFAULT_VECTOR_SETTINGS.threshold,
    tokenBudget: 0,
    favoritedIds: journals.filter((j) => j.isFavorited).map((j) => j.id),
  });
  return fused.results;
}

/** 刷新记忆页的向量状态区（当前空间、各空间条数、每条记忆已索引几段）。 */
async function refreshVectorStatusUI() {
  const statusEl = document.getElementById('vec-status');
  if (!statusEl) return;
  try {
    const spaces = await getIndexSpaces(backend, char.id);
    const kwRows = (await backend.getAll('keywordIndex')).filter((r) => r?.charId === char.id);
    const kwDocs = new Set(kwRows.flatMap((r) => (r.postings || []).map((p) => p.docId)));
    const spaceKey = currentVectorSpaceKey();
    // 维度未知时也显示新空间键（baseUrl|新模型|维度待定），并明确提示需建立索引：
    // 换模型 / 换地址后维度要调一次接口才知道，空间键里的维度先标「维度待定」，
    // 点「建立索引」后按接口返回的维度确定真正的空间键。
    const pendingSpaceKey = (!spaceKey && (embeddingApi.url || embeddingApi.model))
      ? `${normalizeBaseUrl(embeddingApi.url)}|${String(embeddingApi.model || '').trim().toLowerCase()}|维度待定`
      : null;
    let detail = '';
    if (spaceKey) {
      const experiences = await getExperiencesForChar(backend, char.id);
      const st = await getIndexStatus(backend, char.id, [...(char.memoryJournals || []), ...experiences], spaceKey);
      detail = `已索引 ${st.indexedChunks}/${st.totalChunks} 段，缺失 ${st.missing} 段`;
      for (const row of st.perJournal) {
        const span = document.querySelector(`[data-vec-for="${CSS.escape(row.journalId)}"]`);
        if (span) span.textContent = row.wanted ? `已索引 ${row.indexed}/${row.wanted} 段` : '内容为空';
      }
    } else if (pendingSpaceKey) {
      detail = '需建立索引：新空间还没有任何向量段，点「建立索引 / 补齐缺失」后按接口返回的维度确定空间';
    } else {
      detail = '当前空间未确定（建立一次索引后按接口返回的维度确定）';
    }
    statusEl.innerHTML = `
      <div class="kv"><span>向量记忆总开关</span><b>${vectorSettings.enabled ? '开' : '关'}</b></div>
      <div class="kv"><span>当前空间</span><b>${spaceKey ? escapeHtml(spaceKey) : pendingSpaceKey ? escapeHtml(pendingSpaceKey) : '（未确定）'}</b></div>
      <div class="kv"><span>索引状态</span><b>${escapeHtml(detail)}</b></div>
      <div class="kv"><span>各空间条数</span><b>${spaces.length ? spaces.map((s) => `${escapeHtml(s.spaceKey)}：${s.count} 段`).join('；') : '暂无索引'}</b></div>
      <div class="kv"><span>关键词索引</span><b>${kwRows.length} 个词项，覆盖 ${kwDocs.size} 篇文档</b></div>
      <div class="kv"><span>索引进度</span><b>${escapeHtml(vecProgressTextForCurrent(vectorIndexProgress))}</b></div>
      <p class="muted">空间键 = 归一化 Base URL + 模型 + 维度；换模型 / 换维度 / 换地址都会换空间，旧空间的段保留，需在新空间重建。索引只是可重建的缓存，不随备份导出；恢复备份后这里会显示真实的缺失条数。</p>`;
  } catch (e) {
    statusEl.innerHTML = `<p class="err">索引状态读取失败：${escapeHtml(e.message || '')}</p>`;
  }
}

/** 刷新记忆页的联想预算区（本月已用 / 上限；超预算只显示，不弹窗、不阻断聊天）。 */
async function refreshAssocBudgetUI() {
  const statusEl = document.getElementById('assoc-budget-status');
  const limitEl = document.getElementById('assoc-budget-limit');
  if (!statusEl && !limitEl) return;
  try {
    const b = await checkAssocBudget(backend);
    if (limitEl) limitEl.value = String(b.limit);
    if (statusEl) {
      statusEl.innerHTML = `
      <div class="kv"><span>联想召回</span><b>${assocSettings.enabled ? '开' : '关'}</b></div>
      <div class="kv"><span>本月预算</span><b>已用 ${b.used} / ${b.limit} 次（剩余 ${b.budgetLeft} 次）</b></div>
      ${b.allowed ? '' : '<p class="err">本月联想预算已用完：本月不再做联想选择与回执改述核验，聊天不受影响，下月自动恢复。</p>'}
      <p class="muted">预算按月计数，只统计联想选择与回执改述核验的副 API 调用；线索生成不计入预算。</p>`;
    }
  } catch (e) {
    if (statusEl) statusEl.innerHTML = `<p class="err">联想预算读取失败：${escapeHtml(e.message || '')}</p>`;
  }
}

/**
 * 聊天真正用记忆：最新用户发言 + 最近 2 轮对话拼成检索文本 → 关键词路与
 * 向量路各出候选 → RRF k=60 只按排名融合 → 按事件去重取 topN。
 * 两路独立：向量未配置/失败时只走关键词（keywordOnly），关键词索引未建/
 * 失败时只走向量（vectorOnly）；失败不阻断聊天，错误汇总进 error 由调用方处理。
 * 返回 {retrieved, error, spaceKey, query, neighbors, keywordOnly, vectorOnly}，
 * 前四项与旧外形一致；neighbors 是独立附加的紧邻轮次（本波不注入提示词，
 * 注入是第 4 波聊天请求重组的事），retrieved 里不含邻居、不占 topN。
 * 发给主模型的是记忆文字，不是向量数组。
 */
async function retrieveForChat(history) {
  const empty = { retrieved: [], error: null, spaceKey: null, query: '', neighbors: [], keywordOnly: false, vectorOnly: false, queryEmbedding: null };
  const journals = char.memoryJournals || [];
  const experiences = await getExperiencesForChar(backend, char.id).catch(() => []);
  if (!journals.some(journalRetrievable)
    && !experiences.some((e) => isExperienceValid(e) && e.retrievalEnabled !== false)) return empty;
  const latestUser = [...history].reverse().find((m) => m.role === 'user');
  if (!latestUser) return empty;
  const latestText = extractProtocolText(messageText(latestUser)) || messageText(latestUser);
  if (!latestText.trim()) return empty;
  // 最近 2 轮已完成的对话作指代上下文（「那次」「那里」靠这些文本消解）。
  const recentMsgs = selectMessagesForRounds(history, 2, char)
    .filter((m) => m.id !== latestUser.id);
  const recentTexts = recentMsgs.map((m) => extractProtocolText(messageText(m)) || messageText(m)).filter(Boolean);
  const query = buildRetrievalQueryText(latestText, recentTexts);
  // 向量路只在已配置向量 API 时跑：取查询向量并确定空间键；失败时不抛，
  // 留给 fusedRetrieve 只走关键词路，并把错误带给调用方。
  let queryEmbedding = null;
  let spaceKey = null;
  let embeddingError = null;
  if (vectorSettings.enabled && embeddingApi.url && embeddingApi.key && embeddingApi.model) {
    try {
      const { vectors, dimensions } = await callEmbeddings(embeddingApi, [query]);
      if (vectors?.[0]) {
        queryEmbedding = vectors[0];
        const dimsFor = `${embeddingApi.url}|${embeddingApi.model}`;
        if (vectorSettings.dimensionsFor !== dimsFor || vectorSettings.dimensions !== dimensions) {
          vectorSettings.dimensions = dimensions;
          vectorSettings.dimensionsFor = dimsFor;
          await saveVectorSettings();
        }
        spaceKey = spaceKeyFor({ baseUrl: embeddingApi.url, model: embeddingApi.model, dimensions });
      }
    } catch (e) {
      embeddingError = e?.message || String(e);
    }
  }
  const fused = await fusedRetrieve(backend, char, query, queryEmbedding, {
    spaceKey, journals, experiences, history,
    topN: vectorSettings.topK, threshold: vectorSettings.threshold,
    tokenBudget: vectorSettings.tokenBudget,
    favoritedIds: journals.filter((j) => j.isFavorited).map((j) => j.id),
  });
  return {
    retrieved: fused.results,
    error: embeddingError || fused.error,
    spaceKey, query, queryEmbedding,
    neighbors: fused.neighbors,
    keywordOnly: fused.keywordOnly,
    vectorOnly: fused.vectorOnly,
  };
}

/**
 * 构建一次请求（提示词 + 上下文 + 请求体），「本次发送内容预览」与 Get Reply 共用同一份结果。
 * 历史、角色设定、世界书、表情包、API 选项、向量设置、记忆内容、索引指纹任一变化
 * 都会改变签名，缓存失效重建；否则直接复用上一次的构建对象，不重新构建。
 * 同一次请求的检索只做一次：预览与发送共用 buildCurrentRequest 的缓存，
 * 检索结果存在 lastBuiltRequest.retrieved 里，不会各调一次向量接口。
 */
async function buildCurrentRequest() {
  const history = await backend.getAllMessages(char.id);
  const last = history[history.length - 1];
  const maxMem = Math.max(1, parseInt(char?.maxMemory, 10) || 80);
  const tail = history.slice(-maxMem).map((m) => `${m.id}:${m.updatedAt || m.timestamp}`).join(',');
  const journals = char.memoryJournals || [];
  const journalSig = journals.map((j) => `${j.id}:${j.isFavorited ? 1 : 0}:${j.retrievalEnabled !== false ? 1 : 0}:${j.updatedAt || j.timestamp || 0}:${hashString(`${j.title || ''}|${j.content || ''}`)}`).join(',');
  const experiences = await getExperiencesForChar(backend, char.id);
  const expSig = experiences.map((e) => `${e.id}:${e.status}:${e.retrievalEnabled !== false ? 1 : 0}:${e.updatedAt || e.timestamp || 0}:${hashString(`${e.title || ''}|${e.summary || ''}`)}`).join(',');
  const chunks = (await backend.getAll('vectorChunks')).filter((c) => c.charId === char.id);
  const chunkSig = chunks.map((c) => `${c.id}:${c.hash}`).sort().join(',');
  // 关键词索引变化（编辑/删除/失效同步）同样改变检索结果，要进签名。
  const kwRows = (await backend.getAll('keywordIndex')).filter((r) => r.charId === char.id);
  const kwSig = kwRows.map((r) => `${r.term}:${(r.postings || []).length}`).sort().join(',');
  // 签名因子含主 API 的 model（只改模型不失效缓存是审计发现的坑，这里修掉）
  // 与联想配置（assocSettings.enabled）；任一因子变化都重建。
  const sig = buildRequestSignature({
    c: char.id, h: history.length, l: last?.id || '', t: last?.timestamp || 0, tail,
    p: apiSettings.provider || 'openai', model: apiSettings.model || '', tp: !!apiSettings.timePerceptionEnabled,
    v: resolvePromptVersion(char, globalSettings),
    ch: [char.persona, char.myPersona, char.worldBookIds, char.stickerGroups, char.bilingualModeEnabled, char.replyCountMin, char.replyCountMax, char.maxMemory, char.promptOverride, char.statusPanel, char.statusMode, char.innerVoicePrompt],
    wb: worldBooks, st: stickers,
    vec: { e: vectorSettings.enabled, k: vectorSettings.topK, th: vectorSettings.threshold, b: vectorSettings.tokenBudget, emb: [embeddingApi.provider, embeddingApi.url, embeddingApi.model] },
    j: journalSig, ch2: chunkSig, e: expSig, kw: kwSig,
    assoc: assocSettings.enabled,
  });
  if (lastBuiltRequest && lastBuiltRequest.sig === sig) {
    return { ...lastBuiltRequest, reused: true };
  }
  const { retrieved, error: retrievalError, spaceKey, query: retrievalQuery, neighbors: retrievalNeighbors, queryEmbedding } = await retrieveForChat(history);
  if (retrievalError) {
    toast(retrieved.length
      ? '记忆检索有一路失败，本次只用了另一路的召回结果，已继续正常聊天'
      : '记忆检索失败，已继续正常聊天（本次没有召回记忆）');
  }
  // 联想召回（第 3 波）：在准确检索之后、组装请求之前，只做当轮选择。选空 /
  // 超时 / 超预算都不抛错、不阻断聊天；结果存进 lastBuiltRequest.assoc，
  // 由下面的 buildSystemPrompt 按 use 注入“联想旧事”区块（第 4 波），
  // pick 的文档内容按 docId 从经历记录里取。
  // 注意：预览也会触发这一步（与发送共用同一份构建结果），每次签名变化
  // 的重建都可能消费一次联想预算。
  let assoc;
  if (assocSettings.enabled && summaryApi.url && summaryApi.key && summaryApi.model) {
    try {
      const embedTexts = (vectorSettings.enabled && embeddingApi.url && embeddingApi.key && embeddingApi.model)
        ? (texts) => callEmbeddings(embeddingApi, texts)
        : null;
      assoc = await runAssocForChat({
        backend, charId: char.id, queryText: retrievalQuery, queryEmbedding, spaceKey,
        fusedResults: retrieved, experiences, summaryApi, embedTexts,
        assocEnabled: assocSettings.enabled,
      });
    } catch (e) {
      console.warn('联想召回失败（聊天不受影响）：', e);
      assoc = emptyAssoc('error', { reason: '联想召回失败，已按选空处理。' });
    }
  } else {
    assoc = emptyAssoc(assocSettings.enabled ? 'no-api' : 'disabled', {
      reason: assocSettings.enabled ? '未配置总结副 API，联想未启用。' : '联想召回总开关已关闭。',
    });
  }
  // 第 4 波：请求按区块重组——阶段背景 / 检索证据（仅 sourced）+ 邻居 /
  // 联想旧事；原文校验用消息表；三路共用 tokenBudget。
  const messagesById = new Map(history.map((m) => [m.id, m]));
  const assocExperience = assoc?.pick ? experiences.find((e) => e.id === assoc.pick) || null : null;
  // fusedRetrieve 的结果不带 quotes：经历类命中从经历记录里把关键原话富集进来，
  // 原文校验才能逐句核对引文（找不到原话的整条丢弃，不降级成无出处引用）。
  const enrichedRetrieved = retrieved.map((r) => {
    if (r?.docKind === 'experience') {
      const exp = experiences.find((e) => e.id === r.docId);
      return exp?.quotes?.length ? { ...r, quotes: exp.quotes } : r;
    }
    return r;
  });
  const sys = buildSystemPrompt(char, {
    worldBooks, stickers, globalSettings,
    relatedMemories: enrichedRetrieved,
    stageSummaries: journals.filter((j) => j.isSummary),
    neighbors: retrievalNeighbors,
    assoc, assocExperience, messagesById,
    tokenBudget: vectorSettings.tokenBudget,
  });
  const hydrated = await hydrateForRequest(history);
  const req = buildRequest(char, hydrated, sys, { provider: apiSettings.provider || 'openai', timePerceptionEnabled: apiSettings.timePerceptionEnabled });
  lastBuiltRequest = { sig, sys, req, history, reused: false, retrieved, retrievalError, retrievalQuery, spaceKey, neighbors: retrievalNeighbors, assoc, memorySections: sys.memorySections };
  return lastBuiltRequest;
}

function setGenerating(on, label) {
  isGenerating = on;
  const btn = $('#get-reply-btn');
  btn.disabled = false;
  // 图标按钮：空闲星星 / 生成中停止；文字只进 aria-label 与 title。
  btn.innerHTML = on ? '<svg class="icon"><use href="#i-stop"/></svg>' : '<svg class="icon"><use href="#i-sparkle"/></svg>';
  btn.setAttribute('aria-label', on ? (label || '停止生成') : '获取回复');
  btn.title = on ? (label || '停止生成') : '获取回复';
  btn.classList.toggle('generating', !!on);
  $('#composer').classList.toggle('generating', !!on);
  $('#typing-indicator').classList.toggle('hidden', !on);
  if (on) $('#typing-text').textContent = `“${char.remarkName || char.realName}”正在输入中…`;
}

async function getReply() {
  if (isGenerating) { abortController?.abort(); return; }
  const history = await backend.getAllMessages(char.id);
  if (!history.length) { toast('先发点消息吧'); return; }
  if (history[history.length - 1].role === 'assistant') {
    toast('对方已经回复过了，先发点什么吧'); return;
  }
  setGenerating(true);
  abortController = new AbortController();
  streamBuf = '';
  // 生成中断标记：刷新/前后台切换后，启动时凭这个标记提示“上次生成已中断”，
  // 绝不自动续生成（chatDaily.js recoverInterruptedMessages / shouldResumeGeneration）。
  localStorage.setItem('uwu-chat.generating', '1');
  const roundId = uid('round');
  // 本轮请求的联想选择（buildCurrentRequest 里算出）：只在真实发送路径里
  // 有；模拟回复不走构建，不带联想选择，回执也就不结算。
  let assocForRound = null;
  try {
    if (!apiSettings.url || !apiSettings.key || !apiSettings.model) {
      // 无密钥：本地模拟回复，明确标注
      setSaveState('模拟回复 · 未调用真实 API');
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
      const raw = mockReplyText(char, messageText(history[history.length - 1]) || '', stickers);
      await handleAiReplyContent(raw, roundId, { mock: true });
      return;
    }
    // 与「本次发送内容预览」同一份构建结果：刚预览过且历史未变时直接复用。
    const built = await buildCurrentRequest();
    assocForRound = built.assoc || null;
    const { req } = built;
    const streamBox = await createStreamingBubble();
    const { text } = await sendChat(apiSettings, req.body, {
      signal: abortController.signal,
      onDelta: (d) => { streamBuf += d; updateStreamingBubble(streamBox, streamBuf); },
    });
    streamBuf = text || streamBuf;
    removeStreamingBubble(streamBox);
    await handleAiReplyContent(streamBuf, roundId, { assoc: assocForRound });
  } catch (e) {
    if (e?.name === 'AbortError' || abortController?.signal.aborted) {
      // 停止：已解析出的完整片段照常落库，未闭合片段保留为纯文本
      if (streamBuf.trim()) {
        toast('已停止生成');
        await handleAiReplyContent(streamBuf, roundId, { partial: true, assoc: assocForRound });
      }
    } else {
      showApiErrorModal(e);
    }
  } finally {
    setGenerating(false);
    abortController = null;
    streamBuf = '';
    localStorage.removeItem('uwu-chat.generating');
    // 一轮回复落定后检查自动总结（未开启或未到轮数时静默返回，不打扰聊天）。
    void maybeAutoSummarize();
  }
}

function showApiErrorModal(e) {
  const friendly = friendlyErrorMessage(e);
  showModal('出错了', `<p>${escapeHtml(friendly)}</p><p class="muted">已发送的消息没有丢失，可以重试。</p>`, [
    { label: '重试', primary: true, onClick: () => getReply() },
    { label: '关闭' },
  ]);
}

/* ---------------- 记忆总结 ---------------- */
// 生成一份总结并存为独立记忆（journals 表一条新记录，带 isSummary 标记）。
// 成功后才推进增量进度（lastSummarizedMessageId / summarizedRounds）；失败不推进、
// 不写记忆、不影响聊天。总结只走总结副 API，未配置时明确提示，绝不偷用主 API。
async function generateSummary(selected, { source, titleSuffix }) {
  if (!selected?.length) return { ok: false, message: '没有可总结的聊天记录。' };
  if (!summaryApi.url || !summaryApi.key || !summaryApi.model) {
    return { ok: false, message: '未配置记忆总结副 API：请先在「我 → API 设置 → 记忆总结副 API」里填写 Base URL、API Key 和模型。总结不会使用主 API。' };
  }
  const rounds = countRounds(selected, char);
  if (!rounds) return { ok: false, message: '选定范围里没有完整的一轮对话（需要一次用户发言 + 对应 AI 回复）。' };
  const transcript = extractSummarizableText(selected, char);
  if (!transcript.trim()) return { ok: false, message: '选定范围里没有可总结的正文（状态、思考、HTML 模板类内容不进总结）。' };
  const req = buildSummaryRequest({ prompt: summarySettings.prompt, length: summarySettings.length, transcript });
  let text;
  try {
    text = (await callSummaryChat(summaryApi, req.messages)).trim();
  } catch (e) {
    return { ok: false, message: e.message || '总结调用失败。' };
  }
  if (!text) return { ok: false, message: '副 API 没有返回总结文字，请重试。' };
  const now = Date.now();
  const dateStr = new Date(now).toISOString().slice(0, 10);
  const journal = {
    id: uid('journal'), charId: char.id,
    title: `总结 · ${dateStr}（${rounds} 轮）${titleSuffix ? ` · ${titleSuffix}` : ''}`,
    content: text,
    source,
    isFavorited: false,
    isSummary: true,
    sourceMessageIds: selected.map((m) => m.id),
    range: { fromMessageId: selected[0].id, toMessageId: selected[selected.length - 1].id, rounds },
    timestamp: now, createdAt: now,
  };
  await backend.put('journals', journal);
  await attachJournals(char);
  // 新生成的总结记忆同样进向量索引（后台做，失败不影响总结本身）。
  scheduleReindexDocument(journal);
  // 成功后才推进进度；只向前推进，不回退（手动总结旧范围不改锚点）。
  const history = await backend.getAllMessages(char.id);
  const anchorIdx = summarySettings.lastSummarizedMessageId
    ? history.findIndex((m) => m.id === summarySettings.lastSummarizedMessageId) : -1;
  const lastIdx = history.findIndex((m) => m.id === selected[selected.length - 1].id);
  if (lastIdx > anchorIdx) {
    summarySettings.lastSummarizedMessageId = selected[selected.length - 1].id;
    summarySettings.summarizedRounds = (summarySettings.summarizedRounds || 0) + rounds;
    await saveSummarySettings();
  }
  return { ok: true, journal, rounds };
}

// 自动总结：默认关闭；每累计 N 轮触发一轮。只在 AI 回复完成后检查，
// 失败只提示一次，不影响聊天、不推进进度、不重复写。
async function maybeAutoSummarize() {
  if (!summarySettings.autoEnabled || summaryRunning) return;
  if (!summaryApi.url || !summaryApi.key || !summaryApi.model) return;
  try {
    const history = await backend.getAllMessages(char.id);
    const rest = unsummarizedMessages(history, summarySettings.lastSummarizedMessageId);
    const rounds = countRounds(rest, char);
    if (rounds < Math.max(1, summarySettings.everyRounds || 30)) return;
    summaryRunning = true;
    try {
      const res = await generateSummary(rest, { source: '自动总结', titleSuffix: '' });
      if (res.ok) toast(`已自动生成一份聊天总结（${res.rounds} 轮），见「记忆」页。`);
      else console.warn('自动总结失败（聊天不受影响）：', res.message);
    } finally {
      summaryRunning = false;
    }
  } catch (e) {
    console.warn('自动总结检查失败（聊天不受影响）：', e);
  }
}

async function createStreamingBubble() {
  const wrap = el('div', 'msg message-wrapper received is-streaming');
  const body = el('div', 'msg-body message-bubble-row');
  const bubble = createTextBubble('');
  body.appendChild(bubble);
  wrap.appendChild(body);
  messageArea.appendChild(wrap);
  scrollToBottomIfNear();
  return { wrap, bubble };
}
function updateStreamingBubble(box, text) {
  if (!box) return;
  // 流式过程只显示纯文本预览，不执行协议指令
  box.bubble.querySelector('.bubble-text').textContent = text.replace(/^\[.*?(?:消息|回复)[：:]/, '').slice(0, 600);
  scrollToBottomIfNear();
}
function removeStreamingBubble(box) { box?.wrap.remove(); }

async function handleAiReplyContent(raw, roundId, opts = {}) {
  let text = String(raw || '');
  // 思维链：本阶段不启用；模型若输出 <thinking>，只取其后的可见部分
  const thinkEnd = text.lastIndexOf('</thinking>');
  if (thinkEnd !== -1) text = text.slice(thinkEnd + '</thinking>'.length);
  text = text.replace(/\[incipere\]/g, '');
  if (!text.trim()) { if (!opts.partial) toast('模型返回了空内容'); return; }

  // 心声解析（innerVoice.js）：在分段之前先剥 [inner_voice] 块，正文进分段，
  // 心声挂到本轮第一条落盘的助理消息上（applySegment 里认领）。
  // 解析失败安静降级（innerVoice=null），协议标记绝不进气泡。
  const parsedInner = parseInnerVoice(text);
  text = parsedInner.cleanContent;
  if (parsedInner.innerVoice) opts = { ...opts, innerVoice: parsedInner.innerVoice };

  const segments = parseReplyText(text, char, { allowedStickers: allowedStickerNames() });
  let first = true;
  for (const seg of segments) {
    if (!opts.mock && !opts.partial) {
      await new Promise((r) => setTimeout(r, first ? 350 + Math.random() * 400 : 800 + Math.random() * 1200));
    }
    first = false;
    await applySegment(seg, roundId, opts);
  }
  await saveCharacter();
  setSaveState('已保存');
  // 联想回执（第 3 波）：每落定一次 AI 回复，已完成回合序号 +1（一轮 =
  // 一次 AI 回复，多气泡同一 roundId 只算一轮；中途停止的回复也算一轮，
  // 它确实落盘并被用户看到了）；再按本轮请求的联想选择结算回执——核对
  // 最终回复是否实际提及所选经历。回执结算不阻塞聊天：副模型核验失败时
  // 只用标记匹配的结果。没有联想选择（模拟回复）时不结算。
  try {
    await bumpCompletedRoundSeq(backend, char.id);
  } catch (e) { console.warn('联想回合序号更新失败：', e); }
  if (opts.assoc?.pick) {
    void settleAssocReceipt({
      backend, charId: char.id, roundId, replyText: text, assoc: opts.assoc, summaryApi,
      excludeNames: [char.realName, char.myName, char.remarkName].filter(Boolean),
    }).catch((e) => console.warn('联想回执结算失败：', e));
  }
}

async function applySegment(seg, roundId, opts) {
  // 隐藏指令：接收/退回转账、接收礼物——执行状态变化，不显示气泡
  if (seg.kind === 'transferResponse') {
    const isReturn = seg.content.includes('退回');
    const target = (await backend.getAllMessages(char.id)).reverse()
      .find((m) => m.role === 'user' && m.transferStatus === 'pending');
    if (target) {
      target.transferStatus = isReturn ? 'returned' : 'received';
      await backend.put('messages', target);
      await renderMessages(false);
      toast(isReturn ? '对方退回了转账' : '对方接收了转账');
    }
    return;
  }
  if (seg.kind === 'giftResponse') {
    const target = (await backend.getAllMessages(char.id)).reverse()
      .find((m) => m.role === 'user' && m.giftStatus === 'sent');
    if (target) {
      target.giftStatus = 'received';
      await backend.put('messages', target);
      await renderMessages(false);
      toast('对方接收了礼物');
    }
    return;
  }

  const msg = segmentToMessage(seg, char, roundId);
  msg.id = uid('msg');
  msg.charId = char.id;
  msg.timestamp = Date.now();
  if (opts.mock) msg.mock = true;

  // 引用：按原文找到被引用的用户消息
  if (seg.kind === 'quote') {
    const all = await backend.getAllMessages(char.id);
    const orig = all.slice().reverse().find((m) => {
      if (m.role !== 'user') return false;
      return extractProtocolText(messageText(m)).trim() === (seg.quoted || '').trim();
    });
    if (orig) msg.quote = { messageId: orig.id, senderId: 'user_me', content: seg.quoted };
    msg.content = `[${char.realName}的消息：${seg.reply}]`;
    msg.parts = [{ type: 'text', text: msg.content }];
  }

  // 撤回：先显示原文，2 秒后变为撤回状态（UWU 原有动画效果）
  if (seg.kind === 'withdraw') {
    msg.content = `[${char.realName}的消息：${seg.original}]`;
    msg.parts = [{ type: 'text', text: msg.content }];
    msg.originalContent = seg.original;
    await backend.put('messages', msg);
    await appendMessageElement(msg);
    setTimeout(async () => {
      msg.isWithdrawn = true;
      msg.content = `[${char.realName}撤回了一条消息：${seg.original}]`;
      msg.parts = [{ type: 'text', text: msg.content }];
      await backend.put('messages', msg);
      await invalidateExperiencesForSourceMessage(msg.id);
      await renderMessages(false);
    }, 2000);
    return;
  }

  // 短状态更新：只改顶栏与状态栏，不显示成普通气泡（原版：非调试不渲染）。
  // 调试模式下才把原文以【调试可见】样式留在消息流里。
  if (seg.kind === 'status') {
    char.status = seg.body || char.status;
    msg.isStatusUpdate = true;
    msg.statusText = seg.body;
    await backend.put('messages', msg);
    await saveCharacter();
    updateHeader();
    if (isDebugMode) {
      const note = el('div', 'msg system-note');
      note.dataset.id = msg.id;
      note.appendChild(el('div', 'bubble message-bubble debug-visible', escapeHtml(seg.body || '')));
      attachMsgMenu(note, msg);
      messageArea.appendChild(note);
      scrollToBottomIfNear();
    }
    return;
  }

  // 用户自定义状态栏：只在 HTML 状态栏模式下解析（statusMode.js）。
  // 简洁模式不注入状态指令、也不从回复里抽状态；心声模式只走 [inner_voice]。
  if (getStatusMode(char) === 'html' && char.statusPanel?.enabled && char.statusPanel.regexPattern) {
    try {
      const out = applyStatusTemplate(seg.content, char.statusPanel, statusTemplateCtx(char));
      if (out) {
        const tpl = await saveStatusTemplate(backend, char.statusPanel);
        msg.isStatusUpdate = true;
        msg.statusText = out.raw;
        msg.templateId = tpl?.id || null;
        msg.templateVersion = tpl?.version || null;
        char.statusPanel.currentStatusRaw = out.raw;
        char.statusPanel.currentStatusHtml = out.html;
        char.statusPanel.history = char.statusPanel.history || [];
        char.statusPanel.history.unshift({ raw: out.raw, html: out.html, timestamp: Date.now() });
        char.statusPanel.history = char.statusPanel.history.slice(0, 20);
        updateHeader(); // 及时刷新简略状态条
        if (isStatusPopupOpen()) { statusViewIndex = 0; renderStatusPopup(); }
      }
    } catch (e) { console.warn('状态栏正则解析错误', e); }
  }

  // 心声认领：本轮第一条落盘的普通助理消息带上 innerVoice（只认领一次，
  // 之后 opts.innerVoice 置空，多气泡同一轮不重复挂）。
  if (opts.innerVoice && !msg.innerVoice) {
    msg.innerVoice = opts.innerVoice;
    opts.innerVoice = null;
  }

  await backend.put('messages', msg);
  await appendMessageElement(msg);
}

async function handleRegenerate() {
  if (isGenerating) return;
  const all = await backend.getAllMessages(char.id);
  const aiMsgs = all.filter((m) => m.role === 'assistant' && m.roundId);
  if (!aiMsgs.length) { toast('没有可重新生成的回复'); return; }
  const lastRound = aiMsgs[aiMsgs.length - 1].roundId;
  const roundMsgs = all.filter((m) => m.roundId === lastRound);
  if (!roundMsgs.length) return;
  char.supersededRounds = char.supersededRounds || [];
  char.supersededRounds.push({ roundId: lastRound, messages: roundMsgs, at: Date.now() });
  for (const m of roundMsgs) await backend.delete('messages', m.id);
  // 被替换轮次的消息是物理删除：同样按来源失效规则处理经历。
  for (const m of roundMsgs) await invalidateExperiencesForSourceMessage(m.id);
  await saveCharacter();
  await renderMessages(false);
  toast('已替换上一轮，可在管理 → 数据管理里恢复');
  await getReply();
}

async function respondToTransfer(messageId, action) {
  const msg = await backend.get('messages', messageId);
  if (!msg) return;
  msg.transferStatus = action;
  await backend.put('messages', msg);
  const content = action === 'received'
    ? `[${char.myName}接收${char.realName}的转账]`
    : `[${char.myName}退回${char.realName}的转账]`;
  const ctxMsg = { id: uid('msg'), charId: char.id, role: 'user', content, parts: [{ type: 'text', text: content }], timestamp: nextTs() };
  await backend.put('messages', ctxMsg);
  await renderMessages(false);
  toast(action === 'received' ? '已接收转账' : '已退回转账');
}

async function receiveGift(messageId) {
  const msg = await backend.get('messages', messageId);
  if (!msg) return;
  msg.giftStatus = 'received';
  await backend.put('messages', msg);
  const content = `[${char.myName}接收了${char.realName}的礼物]`;
  const ctxMsg = { id: uid('msg'), charId: char.id, role: 'user', content, parts: [{ type: 'text', text: content }], timestamp: nextTs() };
  await backend.put('messages', ctxMsg);
  await renderMessages(false);
  toast('已接收礼物');
}

/* ---------------- 顶栏 ··· 聊天设置（次级入口） ----------------
 *  聊天页常驻控制已移入这里：自动回复开关、状态模式切换、保存状态、
 *  多选批量操作、调试开关、API 设置与角色设置入口。
 *  调试开关原来在长按菜单里（日常菜单不应出现调试功能），随这次搬家。 */
/** 顶栏返回：单角色应用没有会话列表，返回即切回上一次所在的非聊天页
 *  （默认动态），Tab 栏随 .in-chat 移除而重新出现。 */
function goBackFromChat() {
  NavShell.switchView(lastHomeView || 'moments');
}

function openChatMenu() {
  const auto = localStorage.getItem('uwu-chat.autoReply') === '1';
  const mode = getStatusMode(char);
  const saveText = $('#save-state')?.textContent || '';
  const modeOptions = Object.entries(STATUS_MODE_LABELS)
    .map(([v, label]) => `<option value="${v}" ${v === mode ? 'selected' : ''}>${label}</option>`).join('');
  showModal('聊天设置', `
    <div class="cm-row"><div class="setting-row"><span class="setting-label">自动回复<small>发完消息后自动获取回复</small></span><label class="switch"><input type="checkbox" id="cm-auto-reply" ${auto ? 'checked' : ''}><span class="switch-track"></span></label></div></div>
    <div class="cm-row"><label>状态模式</label><select id="cm-status-mode">${modeOptions}</select></div>
    <p class="muted">状态模式按角色保存。简洁（默认）：不注入状态指令；心声：生成 [inner_voice] 独白；HTML 状态栏：沿用现有状态模板。切换不删除模板与历史。心声提示词在「角色与状态模板」里改。</p>
    <div class="cm-row"><span>保存状态</span><span class="muted">${escapeHtml(saveText || '—')}</span></div>
    ${selectedMessageIds.size ? `<div class="cm-row"><span>已选 ${selectedMessageIds.size} 条消息</span><span><button id="cm-del-selected">删除所选</button> <button id="cm-clear-selected">清除选择</button></span></div>` : ''}
    <div class="cm-row"><button id="cm-api">API 设置</button><button id="cm-persona">角色与状态模板</button></div>
    <div class="cm-row"><button id="cm-debug">${isDebugMode ? '退出调试' : '进入调试'}</button><span class="muted">调试模式显示状态 / 思考原文</span></div>
    <div class="cm-row"><button id="cm-chat-search">搜索聊天</button><button id="cm-chat-favorites">收藏消息</button><button id="cm-chat-dates">按日期查看</button></div>`,
  [{ label: '关闭' }]);
  $('#cm-auto-reply')?.addEventListener('change', (e) => {
    localStorage.setItem('uwu-chat.autoReply', e.target.checked ? '1' : '0');
    const hidden = $('#auto-reply-toggle');
    if (hidden) hidden.checked = e.target.checked;
  });
  $('#cm-status-mode')?.addEventListener('change', async (e) => {
    char = setStatusMode(char, e.target.value);
    await saveCharacter();
    lastBuiltRequest = null; // 模式换了，缓存的请求要重建（签名里含 statusMode）
    toast(`状态模式已切换为${STATUS_MODE_LABELS[getStatusMode(char)]}`);
  });
  $('#cm-del-selected')?.addEventListener('click', async () => {
    hideModal();
    const ids = [...selectedMessageIds];
    if (!ids.length) return;
    for (const id of ids) {
      await backend.delete('messages', id);
      await invalidateExperiencesForSourceMessage(id);
    }
    selectedMessageIds.clear();
    await renderMessages(false);
    toast(`已删除 ${ids.length} 条消息`);
  });
  $('#cm-clear-selected')?.addEventListener('click', () => {
    selectedMessageIds.clear();
    document.querySelectorAll('.msg.selected').forEach((n) => n.classList.remove('selected'));
    hideModal();
    toast('已清除选择');
  });
  $('#cm-api')?.addEventListener('click', () => { hideModal(); openSettings('api'); });
  $('#cm-persona')?.addEventListener('click', () => { hideModal(); openSettings('persona'); });
  $('#cm-debug')?.addEventListener('click', () => {
    isDebugMode = !isDebugMode;
    hideModal();
    toast(isDebugMode ? '已进入调试模式' : '已退出调试模式');
    renderMessages(false);
  });
  // 聊天记录中心入口（B 组）：三个二级页，复用 ManageView.openSubpage，不加常驻按钮。
  $('#cm-chat-search')?.addEventListener('click', () => { hideModal(); openChatSearch(); });
  $('#cm-chat-favorites')?.addEventListener('click', () => { hideModal(); openChatFavorites(); });
  $('#cm-chat-dates')?.addEventListener('click', () => { hideModal(); openChatDates(); });
}

/* ---------------- 聊天记录中心（B 组） ---------------- */
// 三个二级页复用 ManageView.openSubpage（index.html 里的 sub-chat-search /
// sub-chat-favorites / sub-chat-dates），黑白灰，不加常驻按钮与底部导航。
// 数据查询只走 A 组模块（searchChatMessages / listFavoriteMessages /
// getChatDates / messagesForDay），本文件不另建搜索实现；纯逻辑在
// js/chatCenter.js（可进 Node 测试），这里只做 DOM 接线。
const chatCenterState = {
  search: { keyword: '', sender: 'all', dateFrom: '', dateTo: '', types: [], results: [], nextCursor: null, scrollTop: 0, querySeq: 0 },
  favorites: { results: [], nextCursor: null, scrollTop: 0 },
  dates: { dates: [], year: new Date().getFullYear(), month: new Date().getMonth(), scrollTop: 0 },
  jumpReturn: null, // { from: 'search' | 'favorites' | 'dates' }
  // 引用跳转返回点：{ sourceMessageId, scrollTop }，点引用时记下，返回时跳回并恢复滚动位置。
  quote: null,
};
const CHAT_CENTER_RETURN_LABELS = {
  search: '← 返回搜索结果',
  favorites: '← 返回收藏夹',
  dates: '← 返回日期查看',
  quote: '← 返回引用处',
};

/** 消息定位（全应用唯一的一套定位逻辑）：查到目标消息后按现有分页
 *  往前翻页加载包含它的那一页（复用 renderMessages，不另写消息渲染），
 *  滚动到该消息并短暂高亮 1.5s。returnTo 指定来源页时，在聊天页顶栏下
 *  显示一条轻量返回入口；不传 returnTo 时不显示（横幅跳转走这条）。
 *  找不到消息记录时 toast 提示并返回 false。 */
async function jumpToMessage(messageId, { returnTo } = {}) {
  if (!char?.id || !messageId) return false;
  ManageView.closeSubpage(); // 二级页是覆盖层：先关掉，定位后的聊天页才看得见
  const res = await runJumpToMessage({
    backend, charId: char.id, messageId,
    findTarget: (id) => messageArea.querySelector(`[data-id="${CSS.escape(String(id))}"]`),
    renderLatest: () => renderMessages(false),
    renderOlder: async () => { await renderMessages(true); return { hasMore: hasMoreHistory, oldest: loadedOldest }; },
    scrollTo: (el) => el.scrollIntoView({ block: 'center' }),
    highlight: (el) => {
      el.classList.add('msg-jump-highlight');
      setTimeout(() => el.classList.remove('msg-jump-highlight'), 1500);
    },
    onMissing: () => toast('找不到这条消息，可能已被删除'),
  });
  if (!res.ok) { hideJumpReturnBar(); return false; }
  if (returnTo && CHAT_CENTER_RETURN_LABELS[returnTo]) {
    chatCenterState.jumpReturn = { from: returnTo };
    showJumpReturnBar(returnTo);
  } else {
    chatCenterState.jumpReturn = null;
    hideJumpReturnBar();
  }
  return true;
}

function showJumpReturnBar(from) {
  const bar = $('#jump-return-bar');
  const btn = $('#jump-return-btn');
  const latest = $('#jump-latest-btn');
  if (!bar || !btn) return;
  btn.textContent = CHAT_CENTER_RETURN_LABELS[from] || '← 返回';
  latest?.classList.toggle('hidden', from !== 'dates');
  bar.classList.remove('hidden');
}
function hideJumpReturnBar() { $('#jump-return-bar')?.classList.add('hidden'); }

/** 点返回入口：回到跳过来的那一页，恢复当时的结果与滚动位置（不重新搜索）。 */
function returnFromJump() {
  const from = chatCenterState.jumpReturn?.from;
  hideJumpReturnBar();
  chatCenterState.jumpReturn = null;
  if (from === 'search') openChatSearch({ restore: true });
  else if (from === 'favorites') openChatFavorites({ restore: true });
  else if (from === 'dates') openChatDates({ restore: true });
  else if (from === 'quote') returnToQuoteMessage();
}

/** 引用返回：跳回含引用的那条消息，并恢复点击引用前的聊天滚动位置。 */
async function returnToQuoteMessage() {
  const saved = chatCenterState.quote;
  chatCenterState.quote = null;
  if (!saved?.sourceMessageId) return;
  const ok = await jumpToMessage(saved.sourceMessageId);
  if (ok && typeof saved.scrollTop === 'number') messageArea.scrollTop = saved.scrollTop;
}

function chatCenterNames() {
  return { myName: char?.myName || '', charName: char?.remarkName || char?.realName || '' };
}

/* ---- 搜索页 ---- */
function openChatSearch({ restore = false } = {}) {
  const body = ManageView.openSubpage('chat-search');
  if (!body) return;
  if (!body.dataset.ccBuilt) { buildChatSearchPage(body); body.dataset.ccBuilt = '1'; }
  if (restore) {
    // 从聊天页返回：恢复原来的滚动位置，结果列表不重新搜索。
    body.scrollTop = chatCenterState.search.scrollTop || 0;
    return;
  }
  // 每次打开都重新查：不持有跨打开的 results 缓存，同一页内编辑/删除消息后下次打开即更新。
  chatCenterState.search.results = [];
  chatCenterState.search.nextCursor = null;
  runChatSearch(true);
}

function buildChatSearchPage(body) {
  const chips = CHAT_CENTER_TYPES.map((t) => `<label class="cc-chip"><input type="checkbox" value="${t.value}">${t.label}</label>`).join('');
  body.innerHTML = `
    <input type="search" id="cc-search-input" class="cc-search-input" placeholder="搜索聊天记录…" autocomplete="off" aria-label="搜索聊天记录">
    <div class="cc-filter-row"><span class="setting-label">发送者</span><select id="cc-search-sender" aria-label="发送者筛选"><option value="all">全部</option><option value="me">我</option><option value="ai">对方</option></select></div>
    <div class="cc-filter-row"><span class="setting-label">开始日期</span><input type="date" id="cc-search-from" aria-label="开始日期"></div>
    <div class="cc-filter-row"><span class="setting-label">结束日期</span><input type="date" id="cc-search-to" aria-label="结束日期"></div>
    <div class="cc-types" id="cc-search-types">${chips}</div>
    <p class="muted" id="cc-search-status"></p>
    <div id="cc-search-results"></div>
    <button id="cc-search-more" class="cc-load-more hidden">加载更多</button>`;
  const st = chatCenterState.search;
  const debouncedRun = debounce(() => runChatSearch(true), 300);
  body.querySelector('#cc-search-input')?.addEventListener('input', (e) => {
    st.keyword = e.target.value;
    debouncedRun();
  });
  body.querySelector('#cc-search-sender')?.addEventListener('change', (e) => {
    st.sender = e.target.value;
    runChatSearch(true);
  });
  body.querySelector('#cc-search-from')?.addEventListener('change', (e) => {
    st.dateFrom = e.target.value;
    runChatSearch(true);
  });
  body.querySelector('#cc-search-to')?.addEventListener('change', (e) => {
    st.dateTo = e.target.value;
    runChatSearch(true);
  });
  body.querySelector('#cc-search-types')?.addEventListener('change', (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box) return;
    st.types = [...body.querySelectorAll('#cc-search-types input:checked')].map((c) => c.value);
    runChatSearch(true);
  });
  body.querySelector('#cc-search-results')?.addEventListener('click', (e) => {
    const row = e.target.closest('.cc-result');
    if (!row?.dataset.id) return;
    st.scrollTop = body.scrollTop; // 记下滚动位置，返回时恢复
    jumpToMessage(row.dataset.id, { returnTo: 'search' });
  });
  body.querySelector('#cc-search-more')?.addEventListener('click', () => runChatSearch(false));
}

async function runChatSearch(reset) {
  if (!char?.id) return;
  const st = chatCenterState.search;
  if (reset) { st.results = []; st.nextCursor = null; }
  const statusEl = $('#cc-search-status');
  if (statusEl) statusEl.textContent = '搜索中…';
  const seq = (st.querySeq = (st.querySeq || 0) + 1);
  try {
    const { results, nextCursor } = await searchChatMessages(backend, char.id, {
      ...buildSearchFilters(st), limit: SEARCH_PAGE_SIZE, cursor: reset ? null : st.nextCursor,
    });
    if (seq !== st.querySeq) return; // 后一次查询已发出，丢弃旧结果
    st.results = reset ? (results || []) : [...st.results, ...(results || [])];
    st.nextCursor = nextCursor ?? null;
    renderChatSearchResults();
  } catch (err) {
    console.warn('搜索失败：', err);
    if (statusEl) statusEl.textContent = '搜索失败，请重试';
  }
}

function renderChatSearchResults() {
  const st = chatCenterState.search;
  const { myName, charName } = chatCenterNames();
  const box = $('#cc-search-results');
  if (box) box.innerHTML = st.results.map((r) => searchResultItemHTML(r, myName, charName)).join('');
  const statusEl = $('#cc-search-status');
  if (statusEl) statusEl.textContent = st.results.length ? `共 ${st.results.length} 条结果` : '没有找到相关消息';
  $('#cc-search-more')?.classList.toggle('hidden', !st.nextCursor);
}

/* ---- 收藏夹页（消息收藏，与记忆收藏分开） ---- */
function openChatFavorites({ restore = false } = {}) {
  const body = ManageView.openSubpage('chat-favorites');
  if (!body) return;
  if (!body.dataset.ccBuilt) { buildChatFavoritesPage(body); body.dataset.ccBuilt = '1'; }
  if (restore) {
    body.scrollTop = chatCenterState.favorites.scrollTop || 0;
    return;
  }
  chatCenterState.favorites.results = [];
  chatCenterState.favorites.nextCursor = null;
  runChatFavorites(true);
}

function buildChatFavoritesPage(body) {
  body.innerHTML = `
    <p class="muted">这里只收聊天里的消息，与记忆收藏分开管理；保存为记忆要手动点，不会自动建。</p>
    <div id="cc-fav-results"></div>
    <p class="muted hidden" id="cc-fav-empty">还没有收藏的消息，在聊天里长按消息收藏后，这里会列出来。</p>
    <button id="cc-fav-more" class="cc-load-more hidden">加载更多</button>`;
  const st = chatCenterState.favorites;
  body.querySelector('#cc-fav-results')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cc-act]');
    if (!btn?.dataset.id) return;
    const id = btn.dataset.id;
    if (btn.dataset.ccAct === 'view') {
      st.scrollTop = body.scrollTop;
      jumpToMessage(id, { returnTo: 'favorites' });
    } else if (btn.dataset.ccAct === 'unfav') {
      await unfavoriteMessage(backend, id);
      toast('已取消收藏');
      runChatFavorites(true); // 即时重查列表，不用刷新页面
    } else if (btn.dataset.ccAct === 'save-memory') {
      const msg = await backend.get('messages', id);
      if (!msg) { toast('消息已不存在'); return; }
      const journal = await saveMessageAsMemory(backend, char.id, msg, getMessageText);
      await attachJournals(char);
      scheduleReindexDocument(journal);
      toast('已保存为记忆');
    }
  });
  body.querySelector('#cc-fav-more')?.addEventListener('click', () => runChatFavorites(false));
}

async function runChatFavorites(reset) {
  if (!char?.id) return;
  const st = chatCenterState.favorites;
  if (reset) { st.results = []; st.nextCursor = null; }
  try {
    const { results, nextCursor } = await listFavoriteMessages(backend, char.id, {
      limit: FAVORITES_PAGE_SIZE, cursor: reset ? null : st.nextCursor,
    });
    st.results = reset ? (results || []) : [...st.results, ...(results || [])];
    st.nextCursor = nextCursor ?? null;
    renderChatFavorites();
  } catch (err) {
    console.warn('收藏加载失败：', err);
    toast('收藏加载失败，请重试');
  }
}

function renderChatFavorites() {
  const st = chatCenterState.favorites;
  const { myName, charName } = chatCenterNames();
  const box = $('#cc-fav-results');
  if (box) box.innerHTML = st.results.map((r) => favoriteItemHTML(r, myName, charName)).join('');
  $('#cc-fav-empty')?.classList.toggle('hidden', st.results.length > 0);
  $('#cc-fav-more')?.classList.toggle('hidden', !st.nextCursor);
}

/* ---- 按日期查看页 ---- */
function openChatDates({ restore = false } = {}) {
  const body = ManageView.openSubpage('chat-dates');
  if (!body) return;
  if (!body.dataset.ccBuilt) { buildChatDatesPage(body); body.dataset.ccBuilt = '1'; }
  if (restore) {
    body.scrollTop = chatCenterState.dates.scrollTop || 0;
    return;
  }
  runChatDates();
}

function buildChatDatesPage(body) {
  body.innerHTML = `
    <div class="cc-month-nav"><button id="cc-dates-prev" aria-label="上个月">‹</button><span id="cc-dates-title"></span><button id="cc-dates-next" aria-label="下个月">›</button></div>
    <div id="cc-dates-cal"></div>
    <p class="muted">只显示有聊天记录的日期；点日期跳到当天第一条消息，之后在聊天页按时间顺序浏览。</p>
    <button id="cc-dates-latest" class="cc-load-more">回到最新消息</button>`;
  const st = chatCenterState.dates;
  body.querySelector('#cc-dates-prev')?.addEventListener('click', () => {
    const n = shiftMonth(st.year, st.month, -1);
    st.year = n.year; st.month = n.month;
    renderChatDates();
  });
  body.querySelector('#cc-dates-next')?.addEventListener('click', () => {
    const n = shiftMonth(st.year, st.month, 1);
    st.year = n.year; st.month = n.month;
    renderChatDates();
  });
  body.querySelector('#cc-dates-cal')?.addEventListener('click', async (e) => {
    const day = e.target.closest('[data-date]');
    if (!day) return;
    st.scrollTop = body.scrollTop;
    await jumpToChatDate(day.dataset.date);
  });
  body.querySelector('#cc-dates-latest')?.addEventListener('click', () => {
    ManageView.closeSubpage();
    hideJumpReturnBar();
    chatCenterState.jumpReturn = null;
    messageArea.scrollTop = messageArea.scrollHeight;
  });
}

async function runChatDates() {
  if (!char?.id) return;
  try {
    const dates = await getChatDates(backend, char.id);
    const st = chatCenterState.dates;
    st.dates = dates || [];
    // 默认打开最近有记录的月份；没有记录时留在当月。
    const latest = st.dates[st.dates.length - 1];
    if (latest) {
      const [y, m] = latest.split('-').map(Number);
      st.year = y; st.month = m - 1;
    }
    renderChatDates();
  } catch (err) {
    console.warn('日期加载失败：', err);
    toast('日期加载失败，请重试');
  }
}

function renderChatDates() {
  const st = chatCenterState.dates;
  const box = $('#cc-dates-cal');
  if (box) box.innerHTML = calendarMonthHTML(buildCalendarMonth(st.year, st.month, new Set(st.dates)));
  const title = $('#cc-dates-title');
  if (title) title.textContent = `${st.year}年${st.month + 1}月`;
}

/** 点日期 → 定位到当天第一条消息（dayBounds 校验当天范围；
 *  注意 messagesForDay 第一页取的是当天最新的 limit 条，所以首条要
 *  翻到最旧一页才取得到，见 findFirstMessageOfDay）。 */
async function jumpToChatDate(dateStr) {
  if (!char?.id) return;
  const bounds = dayBounds(dateStr);
  const first = await findFirstMessageOfDay(messagesForDay, backend, char.id, dateStr);
  if (!first || first.timestamp < bounds.start || first.timestamp > bounds.end) { toast('这一天没有消息'); return; }
  await jumpToMessage(first.id, { returnTo: 'dates' });
}

function startQuote(msg) {
  const plain = extractProtocolText(messageText(msg)) || msg.content;
  currentQuote = { messageId: msg.id, senderId: msg.role === 'user' ? 'user_me' : 'assistant', content: plain, senderName: msg.role === 'user' ? char.myName : (char.remarkName || char.realName) };
  $('#quote-text').textContent = currentQuote.content;
  $('#quote-sender').textContent = currentQuote.senderName || '';
  $('#quote-bar').dataset.sender = msg.role;
  $('#view-chat').classList.add('is-replying');
  $('#quote-bar').classList.remove('hidden');
  inputEl.focus();
}
function clearQuote() {
  currentQuote = null;
  $('#view-chat').classList.remove('is-replying');
  $('#quote-bar').classList.add('hidden');
}

function startEditMessage(msg) {
  editingMessageId = msg.id;
  const plain = extractProtocolText(messageText(msg)) || msg.content;
  showModal('编辑消息', `
    <label>内容</label>
    <textarea id="edit-text">${escapeHtml(plain)}</textarea>
    <label>时间</label>
    <input type="datetime-local" id="edit-time" value="${new Date(msg.timestamp - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)}">`,
  [
    { label: '取消' },
    { label: '保存', primary: true, onClick: async () => {
      const text = $('#edit-text').value.trim();
      const timeVal = $('#edit-time').value;
      if (!text) return;
      const m = await backend.get('messages', editingMessageId);
      if (!m) return;
      const name = m.role === 'user' ? (char.myName || '我') : char.realName;
      m.content = `[${name}的消息：${text}]`;
      m.parts = [{ type: 'text', text: m.content }];
      if (timeVal) m.timestamp = new Date(timeVal).getTime();
      m.edited = true;
      m.updatedAt = Date.now();
      await backend.put('messages', m);
      await renderMessages(false);
      toast('已保存编辑');
    } },
  ]);
  setTimeout(() => $('#edit-text')?.focus(), 50);
}

/**
 * 来源消息被删/撤回 → 对应经历标记失效（第 2 波）。
 * 只检查 quotes/sourceMessageIds 的来源；经历记录本身不删，只标 invalid，
 * 并清掉它的两路索引（失效内容不能继续召回）。无原文出处的旧总结本来就
 * 没有来源可失效，不受影响。返回被标失效的经历数。
 */
async function invalidateExperiencesForSourceMessage(messageId) {
  if (!messageId || !char?.id) return 0;
  let n = 0;
  try {
    const exps = await getExperiencesForChar(backend, char.id);
    for (const e of exps) {
      if (!isExperienceValid(e)) continue;
      const ids = new Set([
        ...(e.sourceMessageIds || []),
        ...(e.quotes || []).map((q) => q.messageId),
      ]);
      if (!ids.has(messageId)) continue;
      await markExperienceInvalid(backend, e.id);
      await deleteDocumentIndexes(backend, e.id);
      n++;
    }
  } catch (err) {
    console.warn('经历失效标记失败：', err);
  }
  return n;
}

async function withdrawMessage(msg) {
  const clean = extractProtocolText(messageText(msg)) || msg.content;
  msg.isWithdrawn = true;
  msg.originalContent = clean;
  const name = char.myName || '我';
  msg.content = `[${name} 撤回了一条消息：${clean}]`;
  msg.parts = [{ type: 'text', text: msg.content }];
  await backend.put('messages', msg);
  await invalidateExperiencesForSourceMessage(msg.id);
  await renderMessages(false);
  toast('消息已撤回');
}

/* ---------------- 输入区 ---------------- */
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px';
}
inputEl.addEventListener('input', () => {
  autoGrow();
  $('#composer').classList.toggle('has-text', !!inputEl.value.trim());
  // B 组：输入框有字 = 用户正在发言，唤醒回合让位；清空后恢复。
  wakeEngine?.setUserTyping(!!inputEl.value.trim());
  // 草稿按角色保存（chatDaily.js，300ms 防抖；切页/发送前 flush 落盘）。
  draftSaver?.schedule(inputEl.value);
});
inputEl.addEventListener('keydown', (e) => {
  // 回车发送（手机与桌面一致；Shift+回车换行）。
  // 之前只在非触屏设备上回车发送，iPhone 上回车只换行，又没有别的发送入口，
  // 导致手机上发不出去消息——这是 Dolores 2026-11-20 上午试聊时报的问题。
  // 输入法组字中（isComposing / keyCode 229，如 iPhone 拼音选词）不发送，
  // 否则回车会把没组完的字提前发出并清空输入框。
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendCurrent();
  }
});
async function sendCurrent() {
  const text = inputEl.value.trim();
  if (!text || isGenerating) return;
  inputEl.value = '';
  autoGrow();
  $('#composer').classList.remove('has-text');
  // 发出去就清草稿（已落盘的也清；未落盘的丢弃）。
  draftSaver?.cancel();
  clearDraft(localStorage, char.id);
  await sendUserText(text);
  if (localStorage.getItem('uwu-chat.autoReply') === '1') await getReply();
}
$('#send-btn').addEventListener('click', sendCurrent);
$('#get-reply-btn').addEventListener('click', getReply);
$('#quote-cancel').addEventListener('click', clearQuote);
$('#reply-preview-scrim').addEventListener('click', clearQuote);
$('#quote-return-btn').addEventListener('click', () => {
  if (chatCenterState.jumpReturn?.from === 'quote') returnFromJump();
  else returnToQuoteMessage();
});
$('#quote-latest-btn').addEventListener('click', async () => {
  hideJumpReturnBar();
  chatCenterState.jumpReturn = null;
  chatCenterState.quote = null;
  await renderMessages(false);
  messageArea.scrollTop = messageArea.scrollHeight;
  hideNewMessagesPill();
});
$('#auto-reply-toggle').addEventListener('change', (e) => {
  localStorage.setItem('uwu-chat.autoReply', e.target.checked ? '1' : '0');
});
// 状态栏弹窗的入口：顶栏头像与昵称胶囊（心形按钮已并入这里）——都打开同一个弹窗
$('#top-info-btn').addEventListener('click', openStatusPopup);
$('#char-avatar-btn').addEventListener('click', openStatusPopup);
$('#status-strip').addEventListener('click', openStatusPopup);
// 顶栏返回：回到带 Tab 栏的主界面（上一次离开聊天页时所在的页，默认动态）
$('#chat-back-btn').addEventListener('click', goBackFromChat);
// 顶栏 ···：聊天设置（自动回复 / 状态模式 / 保存状态 / 多选 / 调试 / 各设置入口）
$('#chat-menu-btn').addEventListener('click', openChatMenu);
// 新消息 pill：点它拉到底并清计数
$('#new-msg-pill').addEventListener('click', () => {
  messageArea.scrollTop = messageArea.scrollHeight;
  hideNewMessagesPill();
});
// 聊天记录中心返回条：点它回到跳过来的那一页；日期来源时另有“回到最新消息”
$('#jump-return-btn').addEventListener('click', returnFromJump);
$('#jump-latest-btn').addEventListener('click', () => {
  hideJumpReturnBar();
  chatCenterState.jumpReturn = null;
  messageArea.scrollTop = messageArea.scrollHeight;
});
// 心声面板关闭
$('#inner-voice-close').addEventListener('click', () => $('#inner-voice-panel').classList.add('hidden'));
// Esc 关闭引用与状态弹窗、心声面板
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  clearQuote();
  if (isStatusPopupOpen()) closeStatusPopup();
  $('#inner-voice-panel')?.classList.add('hidden');
  lpMenu?.close();
});
// 阅读位置：滚动停稳后按角色保存（距底偏移 + 最后可见消息 id），切页/刷新后还原
let readPosTimer = null;
messageArea.addEventListener('scroll', () => {
  if (readPosTimer !== null) clearTimeout(readPosTimer);
  readPosTimer = setTimeout(() => {
    readPosTimer = null;
    const lastWrap = messageArea.querySelector('.msg:last-child');
    saveReadingPosition(localStorage, char?.id, {
      lastVisibleMessageId: lastWrap?.dataset.id || null,
      distanceFromBottom: distanceFromBottom(messageArea),
    });
    if (distanceFromBottom(messageArea) <= 48) hideNewMessagesPill();
  }, 300);
});
// 切到后台/关闭页面前把未落盘的草稿 flush
document.addEventListener('visibilitychange', () => { if (document.hidden) draftSaver?.flush(); });
window.addEventListener('pagehide', () => draftSaver?.flush());

/* ---------------- 自定义状态栏：沙箱 iframe 隔离渲染 ----------------
 *  模板 HTML 绝不直接 innerHTML 进主页面。它只活在 sandbox="allow-scripts"
 *  且不带 allow-same-origin 的 iframe 里（srcdoc），模板样式只作用于状态栏内部，
 *  脚本也拿不到主页面、聊天数据与 API Key。高度由 iframe 内的脚本 postMessage
 *  上报（跨沙箱边界可用），父页面只认当前 iframe 的 contentWindow 发来的消息。 */
let statusFrame = null;
let statusFrameHeightOk = false;
let statusFrameTimer = null;

window.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === STATUS_HEIGHT_MSG && Number.isFinite(d.height)) {
    // 聊天页 HTML 卡片：高度消息里带 frameId，按 id 路由到对应的 iframe。
    if (d.frame) {
      const f = document.querySelector(`iframe[data-chat-frame="${CSS.escape(String(d.frame))}"]`);
      if (f && e.source === f.contentWindow) {
        f.style.height = `${Math.max(24, Math.min(d.height, 6000))}px`;
      }
      return;
    }
    if (!statusFrame || e.source !== statusFrame.contentWindow) return;
    statusFrameHeightOk = true;
    clearTimeout(statusFrameTimer);
    // 只清“加载超时”的提示：模板脚本报错的提示要留着，别被随后到达的高度消息冲掉
    document.querySelector('#status-custom .status-error[data-kind="timeout"]')?.remove();
    statusFrame.style.height = `${Math.max(24, Math.min(d.height, 6000))}px`;
  } else if (d.type === STATUS_ERROR_MSG) {
    if (!statusFrame || e.source !== statusFrame.contentWindow) return;
    showStatusFrameError(`状态栏模板运行出错：${String(d.message || '').slice(0, 60)}`, 'script');
  }
});

function showStatusFrameError(msg, kind) {
  const host = $('#status-custom');
  if (!host || host.querySelector('.status-error')) return;
  const div = document.createElement('div');
  div.className = 'status-error';
  div.dataset.kind = kind || 'script';
  div.textContent = msg;
  host.prepend(div);
}

/** 用已有原始状态 + 当前模板就地重算渲染产物（不请求模型）。
 *  模板改动后、或旧数据只有原文没有渲染产物时用。只更新当前渲染，不写历史。 */
async function regenerateStatusPreview() {
  const sp = char.statusPanel || {};
  if (!sp.currentStatusRaw || !sp.regexPattern) return false;
  try {
    const out = applyStatusTemplate(sp.currentStatusRaw, sp, statusTemplateCtx(char));
    if (!out) return false;
    await saveStatusTemplate(backend, sp);
    sp.currentStatusHtml = out.html;
    await saveCharacter();
    updateHeader();
    if (isStatusPopupOpen()) { statusViewIndex = 0; renderStatusPopup(); }
    return true;
  } catch (e) { console.warn('状态栏预览重生成失败', e); return false; }
}

/* ---------------- 状态栏弹窗 ----------------
 *  点顶栏昵称标题 / 心形 / 状态条弹出；底部是透明的上一个 / 下一个 / 关闭。
 *  上一个/下一个在状态历史里翻（最新在前），新状态进来时回到最新一条。
 *  渲染仍走沙箱 iframe（见下方的隔离说明），与之前一致。 */
let statusViewIndex = 0;

function statusTemplateCtx(c) {
  const userName = c.myName || 'User';
  const charName = c.realName || 'Character';
  return {
    userAvatar: c.myAvatar || '',
    charAvatar: c.avatar || '',
    userName,
    userRemark: (c.myRemarkName || '').trim() || userName,
    charName,
    charRemark: c.remarkName || charName,
  };
}

function isStatusPopupOpen() {
  return !$('#status-popup').classList.contains('hidden');
}

function openStatusPopup() {
  statusViewIndex = 0;
  renderStatusPopup();
  $('#status-popup').classList.remove('hidden');
}

function closeStatusPopup() {
  $('#status-popup').classList.add('hidden');
}

$('#status-scrim').addEventListener('click', closeStatusPopup);
$('#status-close').addEventListener('click', closeStatusPopup);
$('#status-prev').addEventListener('click', () => {
  const total = statusViewEntries(char.statusPanel || {}).length;
  statusViewIndex = clampStatusIndex(statusViewIndex + 1, total);
  renderStatusPopup();
});
$('#status-next').addEventListener('click', () => {
  const total = statusViewEntries(char.statusPanel || {}).length;
  statusViewIndex = clampStatusIndex(statusViewIndex - 1, total);
  renderStatusPopup();
});

function renderStatusPopup() {
  const sp = char.statusPanel || {};
  const entries = statusViewEntries(sp);
  statusViewIndex = clampStatusIndex(statusViewIndex, entries.length);
  const entry = entries[statusViewIndex] || null;
  const host = $('#status-custom');
  host.innerHTML = '';
  statusFrame = null;
  statusFrameHeightOk = false;
  clearTimeout(statusFrameTimer);
  // 旧数据补救：当前条目有原始状态但没有渲染产物时，用当前模板就地重算一次
  if (entry && entry.raw && !entry.html && sp.regexPattern) {
    try {
      const out = applyStatusTemplate(entry.raw, sp, statusTemplateCtx(char));
      if (out) {
        entry.html = out.html;
        if (statusViewIndex === 0) { sp.currentStatusHtml = out.html; saveCharacter(); }
      }
    } catch (e) { /* 保持空态，下面显示提示 */ }
  }
  if (entry?.html) {
    const frame = document.createElement('iframe');
    frame.className = 'status-frame';
    frame.title = '自定义状态栏';
    frame.setAttribute('sandbox', 'allow-scripts allow-popups');
    frame.setAttribute('scrolling', 'no');
    frame.style.height = '120px'; // 首条高度消息到达前的占位
    // 原版 UWU 只在渲染时做变量匹配（chat_render.js:981/984），提取时存的 HTML
    // 里 {{char_remark}} 这类占位符还是字面量（备份导入的旧条目尤其如此）；
    // 所以渲染前再对已存 HTML 做一次替换——新条目重复替换是空操作，旧条目、
    // 改备注名后的条目也都能对上。注意不要把替换结果写回存储：写回去就把
    // 占位符烤死了，以后改备注名不会再变。
    frame.srcdoc = buildStatusDocument(substituteTemplateVars(entry.html, statusTemplateCtx(char)), { marker: `regen ${Date.now()}` });
    host.appendChild(frame);
    statusFrame = frame;
    statusFrameTimer = setTimeout(() => {
      if (!statusFrameHeightOk && statusFrame === frame && host.contains(frame)) {
        showStatusFrameError('状态栏加载超时，可能是模板有问题，可在下方查看原始内容', 'timeout');
      }
    }, 2500);
  } else {
    const empty = document.createElement('span');
    empty.className = 'muted';
    empty.textContent = entry?.raw
      ? '原始状态与当前模板不匹配，无法渲染'
      : '暂无自定义状态栏内容';
    host.appendChild(empty);
  }
  // 位置提示与前后按钮状态（最新在前：上一个=更早，下一个=更新）
  $('#status-pos').textContent = entries.length ? `第 ${statusViewIndex + 1} / ${entries.length} 条` : '';
  $('#status-prev').disabled = statusViewIndex >= entries.length - 1;
  $('#status-next').disabled = statusViewIndex <= 0;
  renderStatusDetails(sp, entry);
}

function makeStatusDetails(title, text) {
  const det = document.createElement('details');
  det.className = 'status-details';
  const sum = document.createElement('summary');
  sum.textContent = title;
  det.appendChild(sum);
  const pre = document.createElement('pre');
  pre.className = 'status-code';
  pre.textContent = text;
  det.appendChild(pre);
  return det;
}

// 原始文本、HTML 源码、状态历史默认折叠在查看入口里，不与渲染卡片重复铺开。
// 原始文本与 HTML 源码显示当前正在看的那一条（翻页时跟着换），历史列出全部。
function renderStatusDetails(sp, entry) {
  const rawBox = $('#status-raw');
  const histBox = $('#status-history');
  rawBox.innerHTML = '';
  histBox.innerHTML = '';
  if (entry?.raw) rawBox.appendChild(makeStatusDetails('原始文本', entry.raw));
  if (entry?.html) rawBox.appendChild(makeStatusDetails('HTML 源码', entry.html));
  const hist = (sp.history || []).slice(0, 5);
  if (hist.length) {
    const det = document.createElement('details');
    det.className = 'status-details';
    const sum = document.createElement('summary');
    sum.textContent = `状态历史（${hist.length}）`;
    det.appendChild(sum);
    hist.forEach((h) => {
      const row = document.createElement('div');
      row.className = 'status-history-row';
      row.textContent = summarizeStatus(h.raw || '', 60);
      const t = document.createElement('span');
      t.className = 'muted';
      t.textContent = ` · ${formatTimeDivider(h.timestamp)}`;
      row.appendChild(t);
      det.appendChild(row);
    });
    histBox.appendChild(det);
  } else {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = '暂无状态历史';
    histBox.appendChild(d);
  }
}

$('#plus-btn').addEventListener('click', () => openSheet('#action-sheet'));
$('#sticker-btn').addEventListener('click', () => { renderStickerPicker(); openSheet('#sticker-sheet'); });
$('#action-sheet').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  closeSheet('#action-sheet');
  if (act === 'image') { $('#file-input').click(); }
  if (act === 'sticker') { renderStickerPicker(); openSheet('#sticker-sheet'); }
  if (act === 'voice') {
    showModal('语音文字', `<label>语音内容（文字）</label><textarea id="voice-text" placeholder="输入语音要说的话…"></textarea><p class="muted">本阶段只发送语音文字卡，不录音、不做 TTS。</p>`, [
      { label: '取消' },
      { label: '发送', primary: true, onClick: async () => {
        const t = $('#voice-text').value.trim();
        if (!t) return;
        const content = `[${char.myName}的语音：${t}]`;
        const m = { id: uid('msg'), charId: char.id, role: 'user', content, parts: [{ type: 'text', text: content }], timestamp: nextTs() };
        await backend.put('messages', m);
        await appendMessageElement(m);
      } },
    ]);
  }
  if (act === 'photo-desc') {
    showModal('照片 / 视频描述', `<label>画面描述</label><textarea id="pv-text" placeholder="描述这张照片/视频的画面…"></textarea><p class="muted">AI 收到的是描述卡，不会生成真实照片。</p>`, [
      { label: '取消' },
      { label: '发送', primary: true, onClick: async () => {
        const t = $('#pv-text').value.trim();
        if (!t) return;
        const content = `[${char.myName}发来的照片/视频：${t}]`;
        const m = { id: uid('msg'), charId: char.id, role: 'user', content, parts: [{ type: 'text', text: content }], timestamp: nextTs() };
        await backend.put('messages', m);
        await appendMessageElement(m);
      } },
    ]);
  }
  if (act === 'transfer') {
    showModal('转账', `<label>金额（元）</label><input type="number" id="tr-amount" min="0" step="0.01" placeholder="52"><label>备注</label><input type="text" id="tr-remark" placeholder="奶茶钱">`, [
      { label: '取消' },
      { label: '发送转账', primary: true, onClick: async () => {
        const amount = $('#tr-amount').value;
        const remark = $('#tr-remark').value.trim();
        if (!amount || Number(amount) <= 0) { toast('请输入有效金额'); return; }
        const content = `[${char.myName}给你转账：${amount}元；备注：${remark}]`;
        const m = { id: uid('msg'), charId: char.id, role: 'user', content, parts: [{ type: 'text', text: content }], timestamp: nextTs(), transferStatus: 'pending' };
        await backend.put('messages', m);
        await appendMessageElement(m);
      } },
    ]);
  }
  if (act === 'gift') {
    showModal('送礼物', `<label>礼物描述</label><input type="text" id="gift-desc" placeholder="一束花">`, [
      { label: '取消' },
      { label: '送出', primary: true, onClick: async () => {
        const d = $('#gift-desc').value.trim();
        if (!d) return;
        const content = `[${char.myName}送来的礼物：${d}]`;
        const m = { id: uid('msg'), charId: char.id, role: 'user', content, parts: [{ type: 'text', text: content }], timestamp: nextTs(), giftStatus: 'sent' };
        await backend.put('messages', m);
        await appendMessageElement(m);
      } },
    ]);
  }
});

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try { await sendImageMessage(file); }
  catch (err) { toast('图片处理失败，请重试'); console.warn(err); }
});

// 表情包面板状态：分组筛选 + 搜索 + 分批渲染（每次追加一页）。
let stickerPickerGroup = '全部';
let stickerPickerQuery = '';
let stickerPickerShown = STICKER_PAGE_SIZE;

function stickerPickerFiltered() {
  return filterStickers(stickers, { group: stickerPickerGroup, query: stickerPickerQuery });
}

/** 渲染分组 chips（按首次出现顺序；缺 group 的归入「未分类」）。 */
function renderStickerChips() {
  const wrap = $('#sticker-groups');
  const groups = ['全部', ...stickerGroupsOf(stickers)];
  wrap.innerHTML = '';
  for (const g of groups) {
    const chip = el('button', 'sticker-chip' + (g === stickerPickerGroup ? ' active' : ''));
    chip.type = 'button';
    chip.textContent = g === '全部' ? `全部（${stickers.length}）` : g;
    chip.setAttribute('aria-pressed', String(g === stickerPickerGroup));
    chip.onclick = () => { stickerPickerGroup = g; stickerPickerShown = STICKER_PAGE_SIZE; renderStickerGrid(); };
    wrap.appendChild(chip);
  }
}

function stickerCellFallback() {
  return el('div', '', '<svg class="icon"><use href="#i-image"></use></svg>');
}

/** 只渲染当前批次的格子：img 用 loading="lazy"；attachment 异步解析时先放骨架。 */
function renderStickerGrid() {
  const grid = $('#sticker-grid');
  const list = stickerPickerFiltered();
  const shown = list.slice(0, stickerPickerShown);
  grid.innerHTML = '';
  $('#sticker-count').textContent = list.length === stickers.length
    ? `共 ${stickers.length} 个`
    : `已选 ${list.length} 个（共 ${stickers.length} 个）`;
  const empty = $('#sticker-empty');
  if (!stickers.length) {
    empty.textContent = '还没有表情包，去管理 → 贴纸导入。';
    empty.classList.remove('hidden');
  } else if (!list.length) {
    empty.textContent = '没有找到匹配的表情包，换个分组或关键词试试。';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }
  for (const st of shown) {
    const cell = el('button', 'sticker-cell');
    cell.type = 'button';
    const src = stickerImageSrc(st);
    if (src?.kind === 'url') {
      const img = el('img');
      img.src = src.src; img.alt = st.name; img.loading = 'lazy'; img.decoding = 'async';
      img.onerror = () => { img.replaceWith(stickerCellFallback()); };
      cell.appendChild(img);
    } else if (src?.kind === 'attachment') {
      const skel = el('div', 'skel');
      cell.appendChild(skel);
      attachmentDataURL(src.id).then((url) => {
        if (!cell.isConnected) return;
        if (url) {
          const img = el('img');
          img.src = url; img.alt = st.name; img.loading = 'lazy'; img.decoding = 'async';
          img.onerror = () => { img.replaceWith(stickerCellFallback()); };
          skel.replaceWith(img);
        } else skel.replaceWith(stickerCellFallback());
      }).catch(() => { if (cell.isConnected) skel.replaceWith(stickerCellFallback()); });
    } else {
      cell.appendChild(stickerCellFallback());
    }
    cell.appendChild(el('div', 'nm', escapeHtml(`${st.name} · ${stickerGroupOf(st)}`)));
    cell.onclick = async () => {
      closeSheet('#sticker-sheet');
      const content = `[${char.myName}发送的表情包：${st.name}]`;
      const m = { id: uid('msg'), charId: char.id, role: 'user', content, parts: [{ type: 'text', text: content }], timestamp: nextTs(), stickerName: st.name };
      await backend.put('messages', m);
      await appendMessageElement(m);
    };
    grid.appendChild(cell);
  }
  const more = $('#sticker-more');
  const hasMore = list.length > stickerPickerShown;
  more.classList.toggle('hidden', !hasMore);
  more.textContent = hasMore ? `加载更多（已显示 ${shown.length} / ${list.length}）` : '';
}

async function renderStickerPicker() {
  stickerPickerGroup = '全部';
  stickerPickerQuery = '';
  stickerPickerShown = STICKER_PAGE_SIZE;
  const search = $('#sticker-search');
  search.value = '';
  search.oninput = () => { stickerPickerQuery = search.value; stickerPickerShown = STICKER_PAGE_SIZE; renderStickerGrid(); };
  $('#sticker-more').onclick = () => {
    stickerPickerShown += STICKER_PAGE_SIZE;
    renderStickerGrid();
  };
  // 滚动到底部自动续一页（赋值而非 addEventListener，避免重复打开叠加监听）。
  $('#sticker-sheet .sheet-card').onscroll = (e) => {
    const card = e.currentTarget;
    if (card.scrollTop + card.clientHeight >= card.scrollHeight - 160) {
      if (stickerPickerFiltered().length > stickerPickerShown) {
        stickerPickerShown += STICKER_PAGE_SIZE;
        renderStickerGrid();
      }
    }
  };
  renderStickerChips();
  renderStickerGrid();
}

/* ---------------- 设置面板 ---------------- */
const TABS = ['persona', 'prompt', 'worldbook', 'memory', 'stickers', 'api', 'data', 'notify'];
let settingsTab = 'persona';
let settingsContainer = null; // 当前打开的二级页 .sub-body（管理页用二级页，不再用 #settings 浮层）

function openSettings(tab) {
  settingsTab = tab || 'persona';
  settingsContainer = ManageView.openSubpage(settingsTab);
  renderSettingsBody();
}

function field(label, inner, hint) {
  return `<div class="field"><label>${label}</label>${inner}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}
function esc(v) { return escapeHtml(String(v ?? '')); }
function inputVal(id) { return document.getElementById(id)?.value ?? ''; }

/** 记忆页一条 journal 的 HTML（阶段总结 / 固定记忆两处共用）。 */
function journalItemHTML(j) {
  const sourced = sourceStatusOfJournal(j);
  return `
        <div class="list-item">
          <strong>${esc(j.title || '未命名')}</strong>
          ${j.isSummary ? '<span class="badge">总结</span>' : ''}
          <span class="badge">${j.isFavorited ? '★ 已收藏 · 固定注入' : '未收藏'}</span>
          <span class="badge">${j.retrievalEnabled === false ? '不参与检索' : '参与检索'}</span>
          ${j.isSummary && sourced === 'unsourced' ? '<span class="badge">无原文出处·不可引用</span>' : ''}
          <div class="sub">${esc((j.content || '').slice(0, 160))}</div>
          <div class="hint">来源：${esc(j.source || '手动记录')}${j.range?.rounds ? ` · 覆盖 ${esc(String(j.range.rounds))} 轮` : ''}${j.isSummary && sourced === 'sourced' ? ` · 来源消息 ${j.sourceMessageIds.length} 条` : ''} · ${esc(j.timestamp ? formatTimeDivider(j.timestamp) : '')} · <span data-vec-for="${esc(j.id)}">索引状态读取中…</span></div>
          <div class="actions-row">
            <button data-mem-fav="${j.id}">${j.isFavorited ? '取消收藏' : '收藏'}</button>
            <button data-mem-retrieval="${j.id}">${j.retrievalEnabled === false ? '设为参与检索' : '设为不参与检索'}</button>
            <button data-mem-edit="${j.id}">编辑</button>
            <button data-mem-del="${j.id}">${j.isSummary ? '删除总结' : '删除'}</button>
          </div>
        </div>`;
}

/** 记忆页一条经历的 HTML（经历记忆列表用）。receipt 是这件经历的最近一条
 * 联想回执（没有为 null）：记忆页至少能看到每件经历的最近回执状态。 */
function experienceItemHTML(e, receipt = null) {
  const label = planOutcomeLabel(e);
  const clueCount = (e.clues || []).filter((c) => c && c.evidenceVersion === (e.version || 1)).length;
  return `
        <div class="list-item">
          <strong>${esc(e.title || '未命名经历')}</strong>
          ${label ? `<span class="badge">${esc(label)}</span>` : ''}
          ${!isExperienceValid(e) ? '<span class="badge">已失效 · 来源被删/撤回</span>' : ''}
          <span class="badge">${e.retrievalEnabled === false ? '不参与检索' : '参与检索'}</span>
          <div class="sub">${esc((e.summary || '').slice(0, 160))}</div>
          <div class="hint">关键原话 ${e.quotes?.length || 0} 条 · 来源消息 ${e.sourceMessageIds?.length || 0} 条${e.range?.rounds ? ` · 覆盖 ${esc(String(e.range.rounds))} 轮` : ''} · ${esc(e.timestamp ? formatTimeDivider(e.timestamp) : '')} · v${e.version || 1}</div>
          <div class="hint">联想线索 ${clueCount} 条${e.lastMentionedRoundSeq != null ? ` · 上次提及第 ${esc(String(e.lastMentionedRoundSeq))} 轮` : ''} · ${esc(receiptStatusText(receipt))}</div>
          <div class="actions-row">
            <button data-exp-view="${e.id}">查看</button>
            <button data-exp-edit="${e.id}">编辑</button>
            <button data-exp-del="${e.id}">删除</button>
          </div>
        </div>`;
}

/** 查看一条经历：标题 / 关键细节 / 状态 / 关键原话与来源消息。receipt 是
 * 这件经历的最近一条联想回执（没有为 null）。 */
function openExperienceViewer(e, receipt = null) {
  const label = planOutcomeLabel(e);
  const quotes = (e.quotes || []).map((q) => `<p>「${esc(q.text)}」<span class="muted"> —— ${esc(q.speaker || '—')}（消息 ${esc(q.messageId)}）</span></p>`).join('')
    || '<p class="muted">没有关键原话。</p>';
  const clues = (e.clues || []).filter((c) => c && c.evidenceVersion === (e.version || 1));
  const clueLines = clues.map((c) => `<p>· ${esc(c.text)} <span class="muted">（${esc({ context: '当时处境', quote: '特殊原话', future: '未来可能怎样问', unfinished: '未完成事项' }[c.kind] || c.kind)} · 原文「${esc(c.excerpt)}」）</span></p>`).join('')
    || '<p class="muted">还没有联想线索（提取或编辑后由副 API 生成；未配置副 API 时不生成）。</p>';
  showModal(e.title || '未命名经历', `
    <p>${esc(e.summary || '')}</p>
    <p class="muted">状态：${esc(label || '未标注')}${!isExperienceValid(e) ? ' · 已失效（来源被删/撤回，不进检索）' : ''} · 版本 v${e.version || 1}</p>
    <p class="muted">来源消息 ${e.sourceMessageIds?.length || 0} 条${e.range?.rounds ? ` · 覆盖 ${e.range.rounds} 轮` : ''}</p>
    <p class="muted">${esc(receiptStatusText(receipt))}${e.lastMentionedRoundSeq != null ? ` · 上次提及第 ${esc(String(e.lastMentionedRoundSeq))} 轮` : ''}</p>
    <h3>关键原话（${e.quotes?.length || 0} 条）</h3>
    ${quotes}
    <h3>联想线索（${clues.length} 条）</h3>
    ${clueLines}`, [{ label: '关闭' }]);
}

/** 编辑一条经历：标题 / 关键细节 / 计划状态 / 删原话；保存时版本 +1。 */
function openExperienceEditor(e) {
  let quotes = [...(e.quotes || [])];
  const planOptions = [
    ['none', '无计划含义'], ['planned', '计划'], ['completed', '已完成'],
    ['cancelled', '已取消'], ['hypothetical', '假设剧情'],
    ['setting', '角色设定'], ['paraphrase', '转述'],
  ].map(([v, l]) => `<option value="${v}" ${e.plan_state === v ? 'selected' : ''}>${l}</option>`).join('');
  const renderQuotes = () => {
    const box = document.getElementById('exp-edit-quotes');
    if (!box) return;
    box.innerHTML = quotes.map((q, i) => `
    <div class="list-item"><div class="sub">「${esc(q.text)}」</div>
    <div class="hint">${esc(q.speaker || '—')} · 消息 ${esc(q.messageId)}</div>
    <div class="actions-row"><button data-exp-quote-del="${i}">删除这句原话</button></div></div>`).join('')
      || '<p class="muted">没有关键原话。</p>';
  };
  showModal('编辑经历', `
    ${field('标题', `<input type="text" id="exp-edit-title" value="${esc(e.title || '')}">`)}
    ${field('关键细节', `<textarea id="exp-edit-summary" rows="4">${esc(e.summary || '')}</textarea>`)}
    ${field('计划状态', `<select id="exp-edit-plan">${planOptions}</select>`, '结果状态（已完成 / 已取消 / 已改期）只能由后续聊天原文佐证后填，不在这里改。')}
    <h3>关键原话（${quotes.length} 条）</h3>
    <div id="exp-edit-quotes"></div>
    <p class="muted">原话来自聊天原文，带来源消息 ID；保存后版本 +1。至少保留一句原话。</p>`,
  [
    {
      label: '保存', primary: true, onClick: async () => {
        try {
          const saved = await updateExperience(backend, e.id, {
            title: inputVal('exp-edit-title'),
            summary: inputVal('exp-edit-summary'),
            plan_state: inputVal('exp-edit-plan'),
            quotes,
          });
          // 经历编辑后同步两路索引（关键词重建该条 + 向量按 hash 复用或重算），
          // 并按新版本重新生成联想线索（旧线索的 evidenceVersion 已过期）。
          if (saved) scheduleReindexDocument(saved);
          if (saved) scheduleClueGeneration(saved);
          renderSettingsBody();
          toast('经历已保存（版本 +1）');
        } catch (err) {
          toast(err.message || '保存失败');
        }
      },
    },
    { label: '取消' },
  ]);
  renderQuotes();
  document.getElementById('exp-edit-quotes')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-exp-quote-del]');
    if (!btn) return;
    if (quotes.length <= 1) { toast('至少保留一句原话'); return; }
    quotes.splice(Number(btn.dataset.expQuoteDel), 1);
    renderQuotes();
  });
}

// 副 API 配置区（记忆总结 / 向量 Embedding 共用一套结构，各自独立存取）。
function auxApiSectionHTML(kind, cfg, title, hint) {
  const p = `aux-${kind}`;
  const pending = cfg._pending;
  return `
      <h3>${title}</h3>
      ${pending ? `<div class="notice">从备份导入的设置已保存但未自动应用：${esc([pending.url, pending.model].filter(Boolean).join(' · ') || '（空）')}。Key 需单独填写，确认后点「应用导入的设置」。</div>` : ''}
      <p class="muted">${hint}</p>
      ${field('服务商', `<select id="${p}-provider"><option value="openai" ${cfg.provider === 'openai' ? 'selected' : ''}>OpenAI 兼容</option><option value="gemini" ${cfg.provider === 'gemini' ? 'selected' : ''}>Gemini 原生</option></select>`, 'Gemini 原生走独立分支，不会把 OpenAI 格式发到 Gemini 接口。')}
      ${field('API 地址（Base URL）', `<input type="text" id="${p}-url" value="${esc(cfg.url || '')}" placeholder="https://api.openai.com/v1">`, '填完整地址；以 /v1 结尾的地址不会被重复拼接。')}
      ${field('API Key', `<input type="password" id="${p}-key" value="${esc(cfg.key || '')}" placeholder="sk-…">`, '只存在本机，默认不进备份、不进日志。')}
      ${field('模型', `<input type="text" id="${p}-model" value="${esc(cfg.model || '')}" placeholder="${kind === 'embedding' ? 'text-embedding-3-small' : 'gpt-4o-mini'}">`, '拉取失败时也可以手动填写。')}
      ${field('搜索模型', `<input type="text" id="${p}-search" placeholder="输入关键字，过滤已拉取的模型">`)}
      <div class="field"><label>已拉取的模型</label><select id="${p}-models"><option value="">（先点「拉取模型」）</option></select><div class="hint">点一个模型就会填进上面的模型框。</div></div>
      <div class="actions-row">
        <button class="primary" id="${p}-save">保存</button>
        <button id="${p}-fetch">拉取模型</button>
        <button id="${p}-test">测试连接</button>
      </div>
      <div id="${p}-result"></div>`;
}

// 已拉取的模型列表（只放当前会话，不进备份）。
const auxModels = { summary: [], embedding: [] };
function bindAuxApiSection(kind) {
  const p = `aux-${kind}`;
  const isSummary = kind === 'summary';
  const getCfg = () => (isSummary ? summaryApi : embeddingApi);
  const readForm = () => ({
    provider: inputVal(`${p}-provider`) || 'openai',
    url: inputVal(`${p}-url`).trim(),
    key: inputVal(`${p}-key`).trim(),
    model: inputVal(`${p}-model`).trim(),
  });
  const renderModelOptions = () => {
    const q = (inputVal(`${p}-search`) || '').trim().toLowerCase();
    const list = (auxModels[kind] || []).filter((m) => !q || m.toLowerCase().includes(q));
    const sel = document.getElementById(`${p}-models`);
    if (!sel) return;
    sel.innerHTML = list.length
      ? list.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
      : '<option value="">（没有匹配的模型）</option>';
  };
  document.getElementById(`${p}-search`)?.addEventListener('input', renderModelOptions);
  document.getElementById(`${p}-models`)?.addEventListener('change', (e) => {
    const v = e.target.value;
    if (v) document.getElementById(`${p}-model`).value = v;
  });
  document.getElementById(`${p}-save`)?.addEventListener('click', async () => {
    const cfg = { ...getCfg(), ...readForm(), _pending: undefined };
    if (isSummary) { summaryApi = cfg; await saveSummaryApi(); }
    else { embeddingApi = cfg; await saveEmbeddingApi(); }
    toast('已保存');
  });
  document.getElementById(`${p}-fetch`)?.addEventListener('click', async () => {
    const box = document.getElementById(`${p}-result`);
    box.innerHTML = '<p class="muted">正在拉取模型列表…</p>';
    const res = await fetchModels(readForm());
    auxModels[kind] = res.models || [];
    renderModelOptions();
    box.innerHTML = res.ok
      ? `<p style="color:#2e7d4f">${esc(res.message || '')}</p>`
      : `<p style="color:#b0442f">${esc(res.message || '')}</p><p class="muted">拉取失败不影响手动填写模型。</p>`;
  });
  document.getElementById(`${p}-test`)?.addEventListener('click', async () => {
    const box = document.getElementById(`${p}-result`);
    box.innerHTML = '<p class="muted">正在测试连接…</p>';
    const res = isSummary ? await testSummaryApi(readForm()) : await testEmbeddingApi(readForm());
    box.innerHTML = res.ok
      ? `<p style="color:#2e7d4f">${esc(res.message || '连接成功')}</p>`
      : `<p style="color:#b0442f">${esc(res.message || '连接失败')}</p>`;
  });
}
function readCharForm() {
  char.realName = inputVal('f-realName') || char.realName;
  char.remarkName = inputVal('f-remarkName') || char.remarkName;
  char.myName = inputVal('f-myName') || '我';
  char.myPersona = inputVal('f-myPersona');
  char.persona = inputVal('f-persona');
  char.status = inputVal('f-status') || char.status;
  char.exclusivePromptVersion = inputVal('f-promptVersion') || '';
  char.replyCountMin = Math.max(1, parseInt(inputVal('f-replyMin') || '3', 10));
  char.replyCountMax = Math.max(char.replyCountMin, parseInt(inputVal('f-replyMax') || '8', 10));
  char.maxMemory = String(parseInt(inputVal('f-maxMemory') || '80', 10) || 80);
  char.bilingualModeEnabled = document.getElementById('f-bilingual')?.checked ?? char.bilingualModeEnabled;
  char.stickerGroups = inputVal('f-stickerGroups');
  char.useRealGallery = document.getElementById('f-useGallery')?.checked ?? false;
  // 状态三模式（statusMode.js）：只改选择字段，模板与历史原样保留。
  char.statusMode = normalizeStatusMode(inputVal('f-status-mode'));
  char.innerVoicePrompt = inputVal('f-inner-voice-prompt');
  char.statusPanel = {
    ...(char.statusPanel || {}),
    enabled: document.getElementById('f-sp-enabled')?.checked ?? false,
    promptSuffix: inputVal('f-sp-suffix'),
    regexPattern: inputVal('f-sp-regex'),
    replacePattern: inputVal('f-sp-replace'),
    historyLimit: Math.max(0, parseInt(inputVal('f-sp-history') || '3', 10)),
  };
}

/** B 组：当前图标源图（内存里，未进 settings；导出图标包时用）。 */
let customIconSourceImage = null;

/** 把 data URL / 图片地址解码成 Image（供图标导出复用已存的小图）。 */
function loadIconImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图标图片解码失败'));
    img.src = src;
  });
}

/**
 * B 组：图标文件选择回调。validateIconFile → 读图 → computeCropRect /
 * previewSpecs 画三档预览 → 180px 压缩 data URL 存 customIconSettings.dataUrl。
 */
async function handleIconFileChange(file) {
  const check = validateIconFile(file);
  if (!check.ok) throw new Error(check.reason);
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图标图片失败'));
    reader.readAsDataURL(file);
  });
  const img = await loadIconImage(dataUrl);
  customIconSourceImage = img;
  const box = document.getElementById('icon-preview');
  if (box) {
    box.innerHTML = '';
    for (const spec of previewSpecs(img)) {
      const c = document.createElement('canvas');
      const show = Math.min(72, spec.size);
      c.width = show; c.height = show;
      c.title = `${spec.size}×${spec.size}`;
      c.getContext('2d').drawImage(img, spec.crop.x, spec.crop.y, spec.crop.size, spec.crop.size, 0, 0, show, show);
      box.appendChild(c);
    }
  }
  // 只存 180px 压缩小图到 settings，大图不进存储，避免撑爆 IndexedDB。
  const small = document.createElement('canvas');
  small.width = 180; small.height = 180;
  const crop = computeCropRect(img.width, img.height);
  small.getContext('2d').drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, 180, 180);
  customIconSettings = { ...customIconSettings, dataUrl: small.toDataURL('image/png') };
  await saveCustomIconSettings();
  toast('图标图片已读入（预览为居中正方形裁切）');
}

function renderSettingsBody() {
  const body = settingsContainer;
  if (!body) return;
  const sp = char.statusPanel || {};
  if (settingsTab === 'persona') {
    body.innerHTML = `
      <div class="field"><label>角色头像</label><input type="file" id="f-avatar-file" accept="image/*"><div class="hint">不上传则使用默认头像。</div></div>
      ${field('角色名', `<input type="text" id="f-realName" value="${esc(char.realName)}">`)}
      ${field('备注名', `<input type="text" id="f-remarkName" value="${esc(char.remarkName || '')}">`, '显示在顶栏和聊天气泡名称里。')}
      ${field('我的名字', `<input type="text" id="f-myName" value="${esc(char.myName)}">`)}
      ${field('状态（顶栏短状态）', `<input type="text" id="f-status" value="${esc(char.status || '')}">`)}
      ${field('角色人设', `<textarea id="f-persona" rows="5">${esc(char.persona || '')}</textarea>`, '不改写原有设定；只编辑你自己的。')}
      ${field('我的人设', `<textarea id="f-myPersona" rows="3">${esc(char.myPersona || '')}</textarea>`)}
      ${field('提示词版本', `<select id="f-promptVersion"><option value="">跟随全局</option><option value="tt" ${char.exclusivePromptVersion === 'tt' ? 'selected' : ''}>TT</option><option value="uwu" ${char.exclusivePromptVersion === 'uwu' ? 'selected' : ''}>UWU 默认</option></select>`, `当前生效：${esc(resolvePromptVersion(char, globalSettings))}（角色未指定专属版本时跟随全局 cotSettings.promptVersion）。`)}
      ${field('每次回复气泡数（最小 - 最大）', `<div class="row"><input type="number" id="f-replyMin" min="1" max="20" value="${char.replyCountMin ?? 3}"> <input type="number" id="f-replyMax" min="1" max="20" value="${char.replyCountMax ?? 8}"></div>`, 'TT 模板用的是这组数值（备份里的 3–8），不是默认的 1–6。')}
      ${field('上下文最大消息数（maxMemory）', `<input type="number" id="f-maxMemory" min="1" max="300" value="${esc(char.maxMemory ?? '80')}">`, '备份里是字符串 "80"，已按数字解析。')}
      ${field('双语模式', `<div class="setting-row"><span class="setting-label">开启<small>原文 + 译文分开显示</small></span><label class="switch"><input type="checkbox" id="f-bilingual" ${char.bilingualModeEnabled ? 'checked' : ''}><span class="switch-track"></span></label></div>`)}
      ${field('可用表情包分组（逗号分隔）', `<input type="text" id="f-stickerGroups" value="${esc(char.stickerGroups || '')}">`)}
      ${field('照片库', `<div class="setting-row"><span class="setting-label">使用真实照片库<small>角色照片/视频描述里按名称匹配</small></span><label class="switch"><input type="checkbox" id="f-useGallery" ${char.useRealGallery ? 'checked' : ''}><span class="switch-track"></span></label></div>`)}
      <h3>状态模式（按角色保存）</h3>
      ${field('状态模式', `<select id="f-status-mode">${Object.entries(STATUS_MODE_LABELS).map(([v, label]) => `<option value="${v}" ${getStatusMode(char) === v ? 'selected' : ''}>${label}</option>`).join('')}</select>`, '简洁（默认）：不注入状态指令；心声：生成 [inner_voice] 独白；HTML 状态栏：沿用下面这套状态模板。切换不删除模板与历史。')}
      ${field('心声提示词', `<textarea id="f-inner-voice-prompt" rows="3" placeholder="${esc(DEFAULT_INNER_VOICE_PROMPT)}">${esc(char.innerVoicePrompt || '')}</textarea>`, '仅心声模式使用；留空则用默认提示词。')}
      <h3>用户自定义状态栏</h3>
      ${field('启用', `<div class="setting-row"><span class="setting-label">启用状态栏正则</span><label class="switch"><input type="checkbox" id="f-sp-enabled" ${sp.enabled ? 'checked' : ''}><span class="switch-track"></span></label></div>`)}
      ${field('promptSuffix', `<input type="text" id="f-sp-suffix" value="${esc(sp.promptSuffix || '')}">`)}
      ${field('regexPattern', `<textarea id="f-sp-regex" rows="3" spellcheck="false">${esc(sp.regexPattern || '')}</textarea>`, '支持 /pattern/flags 与不带斜杠两种写法；多行正则也可以，未写 flags 时默认 gs。')}
      ${field('replacePattern', `<textarea id="f-sp-replace" rows="8" spellcheck="false">${esc(sp.replacePattern || '')}</textarea>`, '支持 $1、$2 占位；可写完整 HTML 模板（style / class / 动画等都会保留，在沙箱 iframe 里渲染，不影响聊天界面）。')}
      ${field('historyLimit', `<input type="number" id="f-sp-history" min="0" max="20" value="${sp.historyLimit ?? 3}">`)}
      <div class="actions-row"><button class="primary" id="f-save-char">保存角色设置</button><button id="f-regen-status">用已有原始状态重新生成预览</button></div>`;
    $('#f-avatar-file').addEventListener('change', async (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      const { blob } = await compressImageFile(f, { maxSize: 256, quality: 0.85 });
      const attId = await saveAttachment(blob, f.name);
      char.avatar = `attachment:${attId}`;
      await saveCharacter();
      updateHeader();
      toast('头像已更换');
    });
    $('#f-save-char').addEventListener('click', async () => { readCharForm(); await saveCharacter(); await regenerateStatusPreview(); updateHeader(); toast('角色设置已保存'); });
    $('#f-regen-status').addEventListener('click', async () => {
      readCharForm();
      await saveCharacter();
      const ok = await regenerateStatusPreview();
      toast(ok ? '已按新模板重新生成预览' : '当前原始状态与新模板不匹配，未更改');
    });
    return;
  }

  if (settingsTab === 'prompt') {
    body.innerHTML = `
      <p class="muted">基准模板为只读（TT 与 UWU 默认模板原文迁移，仅裁剪掉本阶段未实现的模块能力）。下面的覆盖层只影响发送给模型的提示词，不会改动基准模板本身。</p>
      <div class="field"><label>当前生效版本</label><div class="mono">${esc(resolvePromptVersion(char, globalSettings))}</div></div>
      <div class="field"><label>基准模板预览（只读）</label><textarea rows="10" readonly>${esc(buildSystemPrompt(char, { worldBooks, stickers, globalSettings }).systemPrompt.slice(0, 4000))}</textarea><div class="hint">完整提示词见「本次发送内容预览」。</div></div>
      ${field('覆盖层（追加到提示词末尾）', `<textarea id="f-override" rows="5" placeholder="补充说明、语气微调…">${esc(char.promptOverride || '')}</textarea>`, '留空则不追加。恢复默认即清空覆盖层。')}
      <div class="actions-row">
        <button id="f-save-override" class="primary">保存覆盖层</button>
        <button id="f-reset-override">恢复默认</button>
        <button id="f-preview-send">本次发送内容预览</button>
      </div>
      <div id="prompt-modules"></div>`;
    $('#f-save-override').addEventListener('click', async () => { char.promptOverride = inputVal('f-override'); await saveCharacter(); toast('覆盖层已保存'); });
    $('#f-reset-override').addEventListener('click', async () => { char.promptOverride = ''; await saveCharacter(); renderSettingsBody(); toast('已恢复默认'); });
    $('#f-preview-send').addEventListener('click', showSendPreview);
    return;
  }

  if (settingsTab === 'worldbook') {
    const bound = new Set(char.worldBookIds || []);
    body.innerHTML = `
      <p class="muted">绑定决定是否进入提示词；位置（limit_break / before / after / guidelines）与深度（depth）决定插入顺序。</p>
      <div id="wb-list">${worldBooks.map((wb) => `
        <div class="list-item">
          <div class="setting-row"><span class="setting-label"><strong>${esc(wb.title)}</strong><small>${esc(wb.position || 'before')} · depth ${esc(String(wb.depth ?? 0))}</small></span><label class="switch"><input type="checkbox" data-wb="${wb.id}" ${bound.has(wb.id) ? 'checked' : ''}><span class="switch-track"></span></label></div>
          <div class="sub">${esc((wb.content || '').slice(0, 120))}</div>
          <div class="actions-row">
            <button data-wb-edit="${wb.id}">编辑</button>
            <button data-wb-del="${wb.id}">删除</button>
          </div>
        </div>`).join('') || '<p class="muted">还没有世界书。</p>'}</div>
      <h3>新建 / 编辑世界书</h3>
      ${field('标题', `<input type="text" id="wb-title" placeholder="世界书标题">`)}
      ${field('内容', `<textarea id="wb-content" rows="4" placeholder="世界书内容…"></textarea>`)}
      ${field('位置', `<select id="wb-position"><option value="limit_break">limit_break</option><option value="before" selected>before</option><option value="after">after</option><option value="guidelines">guidelines</option></select>`)}
      ${field('深度（depth，数字越小越靠近角色人设）', `<input type="number" id="wb-depth" value="1" min="0" max="100">`)}
      <div class="actions-row"><button class="primary" id="wb-save">保存世界书</button></div>`;
    body.querySelectorAll('[data-wb]').forEach((cb) => cb.addEventListener('change', async () => {
      const set = new Set(char.worldBookIds || []);
      if (cb.checked) set.add(cb.dataset.wb); else set.delete(cb.dataset.wb);
      char.worldBookIds = [...set];
      await saveCharacter();
    }));
    body.querySelectorAll('[data-wb-edit]').forEach((b) => b.addEventListener('click', () => {
      const wb = worldBooks.find((w) => w.id === b.dataset.wbEdit); if (!wb) return;
      $('#wb-title').value = wb.title || '';
      $('#wb-content').value = wb.content || '';
      $('#wb-position').value = wb.position || 'before';
      $('#wb-depth').value = wb.depth ?? 1;
      $('#wb-save').dataset.editId = wb.id;
      $('#wb-title').focus();
    }));
    body.querySelectorAll('[data-wb-del]').forEach((b) => b.addEventListener('click', async () => {
      worldBooks = worldBooks.filter((w) => w.id !== b.dataset.wbDel);
      await backend.delete('worldBooks', b.dataset.wbDel);
      char.worldBookIds = (char.worldBookIds || []).filter((id) => id !== b.dataset.wbDel);
      await saveCharacter();
      renderSettingsBody();
      toast('已删除');
    }));
    $('#wb-save').addEventListener('click', async () => {
      const editId = $('#wb-save').dataset.editId;
      const wb = {
        id: editId || uid('wb'),
        title: inputVal('wb-title').trim() || '未命名世界书',
        content: inputVal('wb-content'),
        position: inputVal('wb-position') || 'before',
        depth: parseInt(inputVal('wb-depth') || '1', 10),
      };
      await backend.put('worldBooks', wb);
      const i = worldBooks.findIndex((w) => w.id === wb.id);
      if (i >= 0) worldBooks[i] = wb; else worldBooks.push(wb);
      if (!char.worldBookIds?.includes(wb.id)) { char.worldBookIds = [...(char.worldBookIds || []), wb.id]; await saveCharacter(); }
      renderSettingsBody();
      toast('世界书已保存');
    });
    return;
  }

  if (settingsTab === 'memory') {
    const journals = char.memoryJournals || [];
    const summaries = journals.filter((j) => j.isSummary);
    const favorites = journals.filter((j) => j.isFavorited);
    body.innerHTML = `
      <p class="muted">收藏的记忆会进提示词。记忆都可查看 / 编辑 / 删除；删除记忆会同时清理它的向量索引段，不影响原始聊天。</p>
      <h3>聊天总结</h3>
      <p class="muted">总结只读选定角色、指定范围的真实聊天，提取重要经历、关系变化、明确约定、稳定喜好、重要人物与未完成事项；不编造，不把猜测写成事实；状态、思考、HTML/状态栏模板代码、Base64 图片与系统提示词不进总结。总结走「记忆总结副 API」，未配置时不会偷用主 API。</p>
      <div id="sum-progress"><p class="muted">正在统计已总结轮数…</p></div>
      ${field('自动总结', `<div class="setting-row"><span class="setting-label">开启<small>默认关闭</small></span><label class="switch"><input type="checkbox" id="sum-auto" ${summarySettings.autoEnabled ? 'checked' : ''}><span class="switch-track"></span></label></div>`, '开启后，每累计指定轮数就自动总结一次未总结的聊天。')}
      ${field('每累计多少轮触发一次自动总结', `<input type="number" id="sum-every" min="1" max="500" value="${summarySettings.everyRounds || 30}">`, '一轮 = 一次用户发言 + 对应完整 AI 回复，多气泡同一轮只算一轮。')}
      ${field('总结提示词（可编辑）', `<textarea id="sum-prompt" rows="6">${esc(summarySettings.prompt || DEFAULT_SUMMARY_PROMPT)}</textarea>`)}
      ${field('总结长度', `<select id="sum-length"><option value="short" ${summarySettings.length === 'short' ? 'selected' : ''}>短（200 字以内）</option><option value="medium" ${summarySettings.length === 'medium' ? 'selected' : ''}>中（500 字以内）</option><option value="long" ${summarySettings.length === 'long' ? 'selected' : ''}>长（1000 字以内）</option></select>`)}
      <div class="actions-row"><button class="primary" id="sum-save-settings">保存总结设置</button></div>
      <h3>向量记忆</h3>
      <p class="muted">先建立索引，聊天时才会按相关性召回记忆。只索引已有的导入记忆与手动记忆，其次是新生成的总结记忆；默认不把全部历史聊天上传给向量接口。索引只是可重建的缓存，不随备份导出。</p>
      <div id="vec-status"><p class="muted">正在读取索引状态…</p></div>
      <p class="muted" id="vec-progress">${vecProgressTextForCurrent(vectorIndexProgress)}</p>
      ${field('向量记忆总开关', `<div class="setting-row"><span class="setting-label">开启<small>关闭后聊天不再做向量检索</small></span><label class="switch"><input type="checkbox" id="vec-enabled" ${vectorSettings.enabled ? 'checked' : ''}><span class="switch-track"></span></label></div>`)}
      ${field('最多召回条数', `<input type="number" id="vec-topk" min="1" max="10" value="${vectorSettings.topK || 5}">`, '默认 5 条。')}
      ${field('相似度阈值', `<input type="number" id="vec-threshold" min="0" max="1" step="0.01" value="${vectorSettings.threshold ?? 0.40}">`, '默认 0.40。默认值来自桩数据实测：近乎原文的查询（最新发言在查询文本里重复一次加权）相关组 0.436–0.664，不相关组经复核远低于阈值；换模型后建议用下面的「测试召回」校准：真实模型下的相似度分布与桩不同，阈值照搬可能召回太多或太少。')}
      ${field('记忆 Token 预算', `<input type="number" id="vec-budget" min="0" max="8000" step="100" value="${vectorSettings.tokenBudget ?? 1500}">`, '召回记忆进请求的总 Token 估算上限，默认 1500，超出时按排名取，至少保留第一条。')}
      <div class="actions-row">
        <button class="primary" id="vec-save">保存向量设置</button>
        <button id="vec-build">建立索引 / 补齐缺失</button>
        <button id="vec-rebuild">重建索引</button>
        <button id="vec-pause">暂停索引</button>
      </div>
      <h3>联想召回</h3>
      <p class="muted">聊天时按线索联想起过去的经历：副模型从候选中严格选一个或空，不强行挑选；已提及的经历 6 轮内不再主动推荐（明确追问除外）。联想只走「记忆总结副 API」，未配置时静默不启用；选中的经历会按 use 注入请求（mention 表示回复里可顺口提到，understand 表示只作背景理解、不要主动提起），注入情况见「设置 → 上下文预览」。</p>
      <div id="assoc-budget-status"><p class="muted">正在读取联想预算…</p></div>
      ${field('联想召回总开关', `<div class="setting-row"><span class="setting-label">开启<small>关闭后聊天不再做联想选择</small></span><label class="switch"><input type="checkbox" id="assoc-enabled" ${assocSettings.enabled ? 'checked' : ''}><span class="switch-track"></span></label></div>`)}
      ${field('每月联想预算（次）', `<input type="number" id="assoc-budget-limit" min="0" max="5000" value="">`, '默认 300 次/月，只统计联想选择与回执改述核验的副 API 调用；超预算跳过联想，不阻断聊天，下月自动恢复。')}
      <div class="actions-row"><button class="primary" id="assoc-save">保存联想设置</button></div>
      <h3>批量任务</h3>
      <p class="muted">用户主动启动的分批任务：为全部历史提取经历、为旧经历补线索、重建关键词索引、重建向量索引。每个任务可暂停/恢复，进度保存在本机；页面关闭后任务不会在后台继续，回来会显示“已暂停/未完成”，点“继续”可接着做。任务不开机自动跑。</p>
      <div id="memory-jobs"><p class="muted">正在读取任务…</p></div>
      <div class="actions-row">
        <button id="job-extract-all">为全部历史提取经历</button>
        <button id="job-backfill-clues">为旧经历补线索</button>
        <button id="job-rebuild-keyword">重建关键词索引</button>
        <button id="job-rebuild-vector">重建向量索引</button>
      </div>
      <h3>测试召回</h3>
      <p class="muted">输入一句话，看它会召回哪些记忆、相关度多少。显示前 5 名（不按阈值过滤），并标出每条是否达到当前阈值，方便校准阈值。</p>
      ${field('测试句子', `<input type="text" id="vec-test-q" placeholder="例如：我们上次去海边约了什么">`)}
      <div class="actions-row"><button class="primary" id="vec-test">测试召回</button></div>
      <div id="vec-test-result"></div>
      <h3>手动总结</h3>
      ${field('消息范围', `<select id="sum-scope"><option value="recent">最近 N 轮</option><option value="unsummarized">全部未总结</option></select>`, '「全部未总结」只总结上次总结锚点之后的聊天，不反复覆盖已有记忆。')}
      ${field('最近 N 轮（选「最近 N 轮」时用）', `<input type="number" id="sum-n" min="1" max="500" value="10">`)}
      <div class="actions-row"><button class="primary" id="sum-generate">生成总结</button></div>
      <div id="sum-result"></div>
      <h3>提取经历</h3>
      <p class="muted">从选定范围的聊天原文里提取经历（走「记忆总结副 API」，只在你点按钮时跑一次，不自动跑）。每件经历都带关键原话与来源消息 ID；原话对不上原文的会被丢弃，整件没有有效原话的不写入。提取不推进总结锚点。</p>
      ${field('消息范围', `<select id="exp-scope"><option value="recent">最近 N 轮</option><option value="unsummarized">全部未总结</option></select>`)}
      ${field('最近 N 轮（选「最近 N 轮」时用）', `<input type="number" id="exp-n" min="1" max="500" value="10">`)}
      <div class="actions-row"><button class="primary" id="exp-generate">提取经历</button></div>
      <div id="exp-result"></div>
      <h3>阶段总结（${summaries.length} 条）</h3>
      <div id="mem-summary-list">${summaries.map((j) => journalItemHTML(j)).join('') || '<p class="muted">还没有阶段总结。</p>'}</div>
      <h3>固定记忆（${favorites.length} 条）</h3>
      <div id="mem-fav-list">${favorites.map((j) => journalItemHTML(j)).join('') || '<p class="muted">还没有收藏的记忆。</p>'}</div>
      <h3 id="exp-heading">经历记忆</h3>
      <p class="muted">从聊天原文里提取出的经历，每件都带关键原话与来源消息；失效的（来源被删 / 撤回）不进检索。无原文出处的旧总结会标「无原文出处·不可引用」，引用时不得伪造引用。</p>
      <div id="exp-list"><p class="muted">正在读取经历记忆…</p></div>
      <h3>新增记忆</h3>
      ${field('标题', `<input type="text" id="mem-title" placeholder="一句话标题">`)}
      ${field('内容', `<textarea id="mem-content" rows="4" placeholder="记忆内容…"></textarea>`)}
      ${field('来源', `<input type="text" id="mem-source" placeholder="来源（如：手动记录 / 第 12 轮对话）">`)}
      <div class="actions-row"><button class="primary" id="mem-save">保存记忆</button></div>`;
    // 总结进度（异步统计，不阻塞页面渲染）
    (async () => {
      try {
        const history = await backend.getAllMessages(char.id);
        const rest = unsummarizedMessages(history, summarySettings.lastSummarizedMessageId);
        const unsum = countRounds(rest, char);
        const elp = document.getElementById('sum-progress');
        if (elp) elp.innerHTML = `<p class="muted">已总结 ${summarySettings.summarizedRounds || 0} 轮 · 未总结 ${unsum} 轮${summarySettings.autoEnabled ? `（自动总结已开启，每 ${summarySettings.everyRounds || 30} 轮触发）` : '（自动总结未开启）'}</p>`;
      } catch { /* 统计失败不影响页面 */ }
    })();
    $('#sum-save-settings').addEventListener('click', async () => {
      summarySettings.autoEnabled = document.getElementById('sum-auto')?.checked ?? false;
      summarySettings.everyRounds = Math.max(1, parseInt(inputVal('sum-every') || '30', 10) || 30);
      summarySettings.prompt = inputVal('sum-prompt') || DEFAULT_SUMMARY_PROMPT;
      summarySettings.length = inputVal('sum-length') || 'medium';
      await saveSummarySettings();
      renderSettingsBody();
      toast('总结设置已保存');
    });
    // 向量记忆区绑定
    refreshVectorStatusUI();
    $('#vec-save').addEventListener('click', async () => {
      vectorSettings.enabled = document.getElementById('vec-enabled')?.checked ?? true;
      vectorSettings.topK = Math.max(1, Math.min(10, parseInt(inputVal('vec-topk') || '5', 10) || 5));
      vectorSettings.threshold = Math.max(0, Math.min(1, parseFloat(inputVal('vec-threshold')) || 0));
      vectorSettings.tokenBudget = Math.max(0, parseInt(inputVal('vec-budget') || '1500', 10) || 0);
      await saveVectorSettings();
      toast('向量设置已保存');
    });
    $('#vec-build').addEventListener('click', () => runVectorIndex({ rebuild: false }));
    $('#vec-rebuild').addEventListener('click', async () => {
      if (!confirm('重建索引会清空当前空间的全部向量段再重新生成，记忆原文不受影响。确定重建吗？')) return;
      await runVectorIndex({ rebuild: true });
    });
    $('#vec-pause').addEventListener('click', () => {
      if (vectorIndexCancel) { vectorIndexCancel.cancelled = true; toast('正在暂停索引…'); }
      else toast('当前没有正在进行的索引任务');
    });
    // 联想召回区绑定
    refreshAssocBudgetUI();
    $('#assoc-save').addEventListener('click', async () => {
      assocSettings.enabled = document.getElementById('assoc-enabled')?.checked ?? true;
      await saveAssocSettings();
      const limit = Math.max(0, parseInt(inputVal('assoc-budget-limit') || '300', 10) || 0);
      const cur = await loadAssocBudget(backend);
      await saveAssocBudget(backend, { ...cur, limit });
      await refreshAssocBudgetUI();
      toast('联想设置已保存');
    });
    // 批量任务区绑定
    renderMemoryJobsUI();
    $('#job-extract-all').addEventListener('click', () => startMemoryJob('extract-all'));
    $('#job-backfill-clues').addEventListener('click', () => startMemoryJob('backfill-clues'));
    $('#job-rebuild-keyword').addEventListener('click', () => startMemoryJob('rebuild-keyword'));
    $('#job-rebuild-vector').addEventListener('click', () => startMemoryJob('rebuild-vector'));
    $('#vec-test').addEventListener('click', async () => {
      const q = inputVal('vec-test-q').trim();
      const box = $('#vec-test-result');
      if (!q) { toast('先输入一句话'); return; }
      if (!embeddingApi.url || !embeddingApi.key || !embeddingApi.model) {
        box.innerHTML = '<p style="color:#b0442f">未配置向量 Embedding API：请先在「API 设置 → 向量 Embedding API」里填写。</p>';
        return;
      }
      box.innerHTML = '<p class="muted">正在检索…</p>';
      try {
        const items = await testRecall(q);
        box.innerHTML = items.length
          ? `<table class="preview-table">${items.map((m) => {
            const kindLabel = m.docKind === 'experience' ? '经历' : '记忆';
            const vec = Number.isFinite(m.vectorScore)
              ? `向量 ${m.vectorScore.toFixed(3)}${m.vectorScore >= (vectorSettings.threshold ?? 0.40) ? ' · 达阈值' : ' · 低于阈值'}`
              : '向量 —';
            const kw = Number.isFinite(m.keywordRank) ? `关键词 #${m.keywordRank}` : '关键词 —';
            const vr = Number.isFinite(m.vectorRank) ? ` · 向量 #${m.vectorRank}` : '';
            return `<tr><td>${esc(m.title || '未命名')}</td><td>${kindLabel}</td><td>融合分 ${m.score.toFixed(4)}</td><td>${vec} · ${kw}${vr} · 会召回</td><td>${esc(m.source || '')}${m.date ? ` · ${esc(m.date)}` : ''}${m.sourceStatus ? ` · ${m.sourceStatus === 'sourced' ? '有出处' : '无出处'}` : ''}</td></tr>`;
          }).join('')}</table><p class="muted">共 ${items.length} 条（与聊天同一条融合检索；固定注入的收藏记忆已排除）。</p>`
          : '<p class="muted">没有找到相关记忆（索引可能还没建立，或这句话与已有记忆都不相关）。</p>';
      } catch (e) {
        box.innerHTML = `<p style="color:#b0442f">测试召回失败：${esc(e.message || '')}</p>`;
      }
    });
    $('#sum-generate').addEventListener('click', async () => {
      if (summaryRunning) { toast('正在生成总结，请稍候'); return; }
      const btn = $('#sum-generate');
      const box = $('#sum-result');
      const scope = inputVal('sum-scope');
      const n = Math.max(1, parseInt(inputVal('sum-n') || '10', 10) || 10);
      box.innerHTML = '<p class="muted">正在生成总结…</p>';
      btn.disabled = true;
      summaryRunning = true;
      try {
        const history = await backend.getAllMessages(char.id);
        const selected = scope === 'unsummarized'
          ? unsummarizedMessages(history, summarySettings.lastSummarizedMessageId)
          : selectMessagesForRounds(history, n, char);
        const res = await generateSummary(selected, {
          source: scope === 'unsummarized' ? '手动总结 · 全部未总结' : `手动总结 · 最近 ${n} 轮`,
          titleSuffix: '',
        });
        if (res.ok) {
          box.innerHTML = `<p style="color:#2e7d4f">总结已保存到记忆（${res.rounds} 轮）。</p>`;
          renderSettingsBody();
          toast('总结已保存');
        } else {
          box.innerHTML = `<p style="color:#b0442f">${esc(res.message)}</p>`;
        }
      } catch (e) {
        box.innerHTML = `<p style="color:#b0442f">总结失败：${esc(e.message || '')}</p>`;
      } finally {
        summaryRunning = false;
        btn.disabled = false;
      }
    });
    $('#exp-generate').addEventListener('click', async () => {
      if (experienceRunning) { toast('正在提取经历，请稍候'); return; }
      const btn = $('#exp-generate');
      const box = $('#exp-result');
      const scope = inputVal('exp-scope');
      const n = Math.max(1, parseInt(inputVal('exp-n') || '10', 10) || 10);
      box.innerHTML = '<p class="muted">正在提取经历…</p>';
      btn.disabled = true;
      experienceRunning = true;
      try {
        const history = await backend.getAllMessages(char.id);
        const selected = scope === 'unsummarized'
          ? unsummarizedMessages(history, summarySettings.lastSummarizedMessageId)
          : selectMessagesForRounds(history, n, char);
        const res = await extractExperiencesFromRange(backend, char, selected, {
          summaryApi,
          onProgress: (p) => {
            if (p.phase === 'calling') box.innerHTML = '<p class="muted">正在请副 API 提取经历…</p>';
            else if (p.phase === 'saving') box.innerHTML = `<p class="muted">正在保存经历… ${p.done}/${p.total}</p>`;
          },
        });
        const notes = res.skipped.map((s) => `<p class="muted">${esc(s.reason)}</p>`).join('');
        box.innerHTML = res.created.length
          ? `<p style="color:#2e7d4f">已提取 ${res.created.length} 件经历，见下方「经历记忆」。</p>${notes}`
          : `<p class="muted">没有提取到可写入的经历。</p>${notes}`;
        renderSettingsBody();
        // 新提取的经历进两路索引（关键词立即建，向量后台建），并后台生成联想线索。
        if (res.created.length) for (const rec of res.created) scheduleReindexDocument(rec);
        if (res.created.length) for (const rec of res.created) scheduleClueGeneration(rec);
        if (res.created.length) toast(`已提取 ${res.created.length} 件经历`);
      } catch (e) {
        box.innerHTML = `<p style="color:#b0442f">提取失败：${esc(e.message || '')}</p>`;
      } finally {
        experienceRunning = false;
        btn.disabled = false;
      }
    });
    body.querySelectorAll('[data-mem-fav]').forEach((b) => b.addEventListener('click', async () => {
      const j = journals.find((x) => x.id === b.dataset.memFav); if (!j) return;
      j.isFavorited = !j.isFavorited;
      await backend.put('journals', { ...j, charId: char.id });
      renderSettingsBody();
    }));
    body.querySelectorAll('[data-mem-retrieval]').forEach((b) => b.addEventListener('click', async () => {
      const j = journals.find((x) => x.id === b.dataset.memRetrieval); if (!j) return;
      j.retrievalEnabled = j.retrievalEnabled === false ? true : false;
      await backend.put('journals', { ...j, charId: char.id });
      await attachJournals(char);
      // 检索开关变化要同步两路索引：关掉即清理（不再召回），打开即重建。
      scheduleReindexDocument(j);
      renderSettingsBody();
      toast(j.retrievalEnabled ? '已设为参与检索（索引后台更新）' : '已设为不参与检索（索引已清理）');
    }));
    body.querySelectorAll('[data-mem-edit]').forEach((b) => b.addEventListener('click', () => {
      const j = journals.find((x) => x.id === b.dataset.memEdit); if (!j) return;
      $('#mem-title').value = j.title || '';
      $('#mem-content').value = j.content || '';
      $('#mem-source').value = j.source || '';
      $('#mem-save').dataset.editId = j.id;
      $('#mem-title').focus();
    }));
    body.querySelectorAll('[data-mem-del]').forEach((b) => b.addEventListener('click', async () => {
      const j = journals.find((x) => x.id === b.dataset.memDel); if (!j) return;
      if (!confirm(`确定删除「${j.title || '这条记忆'}」吗？它的向量索引段与关键词记录会一起清理，原始聊天不受影响。`)) return;
      await backend.delete('journals', j.id);
      await deleteDocumentIndexes(backend, j.id);
      await attachJournals(char);
      renderSettingsBody();
      toast('已删除');
    }));
    $('#mem-save').addEventListener('click', async () => {
      const editId = $('#mem-save').dataset.editId;
      const j = {
        id: editId || uid('journal'), charId: char.id,
        title: inputVal('mem-title').trim() || '未命名记忆',
        content: inputVal('mem-content'),
        source: inputVal('mem-source') || '手动记录',
        isFavorited: false, retrievalEnabled: true, timestamp: Date.now(),
      };
      if (editId) {
        const old = journals.find((x) => x.id === editId);
        j.isFavorited = old?.isFavorited || false;
        j.retrievalEnabled = old?.retrievalEnabled !== false;
        // 编辑总结时保留总结标记、来源消息与覆盖范围，不丢增量进度依据。
        // 索引同步由下面的 scheduleReindexDocument 做（关键词重建 + 向量按 hash 复用或重算）。
        if (old?.isSummary) {
          j.isSummary = true;
          j.sourceMessageIds = old.sourceMessageIds;
          j.range = old.range;
          j.createdAt = old.createdAt || j.timestamp;
        }
      }
      await backend.put('journals', j);
      await attachJournals(char);
      scheduleReindexDocument(j);
      renderSettingsBody();
      toast('记忆已保存');
    });
    // 经历记忆列表（异步读库，不阻塞页面渲染）
    (async () => {
      const box = document.getElementById('exp-list');
      const heading = document.getElementById('exp-heading');
      if (!box) return;
      try {
        const exps = await getExperiencesForChar(backend, char.id);
        const receipts = await getAssocReceipts(backend).catch(() => []);
        if (heading) heading.textContent = `经历记忆（${exps.length} 条）`;
        box.innerHTML = exps.map((e) => experienceItemHTML(e, latestReceiptForExp(receipts, e.id))).join('') || '<p class="muted">还没有经历记忆。用上面的「提取经历」从聊天里提取。</p>';
        box.querySelectorAll('[data-exp-view]').forEach((b) => b.addEventListener('click', () => {
          const e = exps.find((x) => x.id === b.dataset.expView); if (!e) return;
          openExperienceViewer(e, latestReceiptForExp(receipts, e.id));
        }));
        box.querySelectorAll('[data-exp-edit]').forEach((b) => b.addEventListener('click', () => {
          const e = exps.find((x) => x.id === b.dataset.expEdit); if (!e) return;
          openExperienceEditor(e);
        }));
        box.querySelectorAll('[data-exp-del]').forEach((b) => b.addEventListener('click', async () => {
          const e = exps.find((x) => x.id === b.dataset.expDel); if (!e) return;
          if (!confirm(`确定删除经历「${e.title || '这条经历'}」吗？原始聊天不受影响。`)) return;
          await deleteExperience(backend, e.id);
          await deleteDocumentIndexes(backend, e.id);
          renderSettingsBody();
          toast('已删除');
        }));
      } catch {
        box.innerHTML = '<p class="muted">经历记忆读取失败。</p>';
      }
    })();
    return;
  }

  if (settingsTab === 'stickers') {
    body.innerHTML = `
      <p class="muted">提示词里只列出「角色」页可用分组内的表情包名称。未知名称发出去时会显示为文字，不会变成破图。</p>
      <div id="stk-list">${stickers.map((s) => `
        <div class="list-item"><strong>${esc(s.name)}</strong> <span class="muted">${esc(s.group || '未分类')}</span>
        <div class="actions-row"><button data-stk-del="${s.id}">删除</button></div></div>`).join('') || '<p class="muted">还没有表情包。</p>'}</div>
      <h3>导入表情包</h3>
      ${field('名称', `<input type="text" id="stk-name" placeholder="表情包名称（发送时按名称匹配）">`)}
      ${field('分组', `<input type="text" id="stk-group" placeholder="日常">`)}
      ${field('图片文件', `<input type="file" id="stk-file" accept="image/*">`)}
      <div class="actions-row"><button class="primary" id="stk-save">保存表情包</button></div>
      <h3>批量导入（文件夹图片，按文件名取名称）</h3>
      <div class="field"><input type="file" id="stk-files" accept="image/*" multiple></div>`;
    body.querySelectorAll('[data-stk-del]').forEach((b) => b.addEventListener('click', async () => {
      stickers = stickers.filter((s) => s.id !== b.dataset.stkDel);
      await backend.delete('stickers', b.dataset.stkDel);
      renderSettingsBody();
      toast('已删除');
    }));
    $('#stk-save').addEventListener('click', async () => {
      const f = $('#stk-file').files?.[0];
      const name = inputVal('stk-name').trim();
      if (!f || !name) { toast('请选图并填名称'); return; }
      const attId = await saveAttachment(f, f.name);
      const rec = { id: uid('stk'), name, group: inputVal('stk-group') || '未分类', attachmentId: attId };
      await backend.put('stickers', rec);
      stickers.push(rec);
      renderSettingsBody();
      toast('表情包已保存');
    });
    $('#stk-files').addEventListener('change', async (e) => {
      const files = [...(e.target.files || [])];
      const group = '导入';
      for (const f of files) {
        const name = f.name.replace(/\.[^.]+$/, '');
        const attId = await saveAttachment(f, f.name);
        const rec = { id: uid('stk'), name, group, attachmentId: attId };
        await backend.put('stickers', rec);
        stickers.push(rec);
      }
      renderSettingsBody();
      toast(`已导入 ${files.length} 个表情包`);
    });
    return;
  }

  if (settingsTab === 'api') {
    const pending = apiSettings._pending;
    const anyPending = pending || summaryApi._pending || embeddingApi._pending;
    body.innerHTML = `
      ${anyPending ? `<div class="notice">从备份导入的 API 设置已保存但未自动应用，确认无误后点「应用导入的设置」。</div>` : ''}
      <p class="muted">只在你点「测试连接」或「Get Reply」时才调用模型；不做后台请求，不自动重试烧额度。</p>
      ${field('服务商', `<select id="api-provider"><option value="openai" ${apiSettings.provider === 'openai' ? 'selected' : ''}>OpenAI 兼容</option><option value="gemini" ${apiSettings.provider === 'gemini' ? 'selected' : ''}>Gemini 原生</option></select>`, 'Gemini 原生走独立分支，不会把 OpenAI 格式发到 Gemini 接口。')}
      ${field('API 地址（Base URL）', `<input type="text" id="api-url" value="${esc(apiSettings.url || '')}" placeholder="https://api.openai.com/v1">`, '填完整地址；以 /v1 结尾的地址不会被重复拼接。')}
      ${field('API Key', `<input type="password" id="api-key" value="${esc(apiSettings.key || '')}" placeholder="sk-…">`, '只存在本机，不会出现在导出文件和预览里。')}
      ${field('模型', `<input type="text" id="api-model" value="${esc(apiSettings.model || '')}" placeholder="gpt-4o-mini">`)}
      ${field('temperature', `<div class="setting-row"><span class="setting-label">启用</span><label class="switch"><input type="checkbox" id="api-temp-enabled" ${apiSettings.temperatureEnabled ? 'checked' : ''}><span class="switch-track"></span></label></div><input type="number" id="api-temp" min="0" max="2" step="0.1" value="${esc(String(apiSettings.temperature ?? 1))}">`)}
      ${field('流式输出', `<div class="setting-row"><span class="setting-label">开启 SSE 流式</span><label class="switch"><input type="checkbox" id="api-stream" ${apiSettings.streamEnabled !== false ? 'checked' : ''}><span class="switch-track"></span></label></div>`)}
      ${field('时间感知', `<div class="setting-row"><span class="setting-label">在提示词里注入当前时间</span><label class="switch"><input type="checkbox" id="api-time" ${apiSettings.timePerceptionEnabled ? 'checked' : ''}><span class="switch-track"></span></label></div>`)}
      <div class="actions-row">
        <button class="primary" id="api-save">保存 API 设置</button>
        <button id="api-test">测试连接</button>
        ${anyPending ? '<button id="api-apply-pending">应用导入的设置</button>' : ''}
      </div>
      <div id="api-result"></div>
      <h3>快捷预设</h3>
      <div id="preset-list">${(apiPresets || []).map((p, i) => `<div class="list-item"><strong>${esc(p.name || p.provider || '')}</strong> <span class="muted">${esc(p.url || '')} · ${esc(p.model || '')}</span> <div class="actions-row"><button data-preset-apply="${i}">应用</button><button data-preset-del="${i}">删除</button></div></div>`).join('') || '<p class="muted">暂无预设。</p>'}</div>
      <div class="actions-row"><button id="preset-save">把当前设置存为预设</button></div>
      ${auxApiSectionHTML('summary', summaryApi, '记忆总结副 API', '只给记忆总结用，不参与聊天；未配置时总结会明确提示，不会偷用主 API。测试会发一次最小的真实聊天调用，以“能出字”为标准。')}
      ${auxApiSectionHTML('embedding', embeddingApi, '向量 Embedding API', '只给向量记忆用；测试会发一次真实 embeddings 调用并校验返回的向量，不只看模型名字判断支不支持。')}`;
    const readApiForm = () => ({
      provider: inputVal('api-provider') || 'openai',
      url: inputVal('api-url').trim(),
      key: inputVal('api-key').trim(),
      model: inputVal('api-model').trim(),
      temperatureEnabled: document.getElementById('api-temp-enabled')?.checked ?? false,
      temperature: parseFloat(inputVal('api-temp')) || 1,
      streamEnabled: document.getElementById('api-stream')?.checked ?? true,
      timePerceptionEnabled: document.getElementById('api-time')?.checked ?? false,
    });
    $('#api-save').addEventListener('click', async () => {
      apiSettings = { ...apiSettings, ...readApiForm(), _pending: undefined };
      await saveApiSettings();
      updateHeader();
      toast('API 设置已保存');
    });
    $('#api-test').addEventListener('click', async () => {
      const cfg = readApiForm();
      const box = $('#api-result');
      box.innerHTML = '<p class="muted">正在测试连接…</p>';
      const res = await testConnection(cfg);
      box.innerHTML = res.ok
        ? `<p style="color:#2e7d4f">连接成功：${esc(res.message || '服务器有响应')}</p>`
        : `<p style="color:#b0442f">连接失败：${esc(res.message || '请检查地址 / Key / 模型')}</p>`;
    });
    $('#api-apply-pending')?.addEventListener('click', async () => {
      const p = apiSettings._pending;
      apiSettings = { ...apiSettings, ...p, _pending: undefined };
      await saveApiSettings();
      // 副 API 的待确认设置一起应用（同样不含 Key，Key 需单独填写）。
      if (summaryApi._pending) { summaryApi = { ...summaryApi, ...summaryApi._pending, _pending: undefined }; await saveSummaryApi(); }
      if (embeddingApi._pending) { embeddingApi = { ...embeddingApi, ...embeddingApi._pending, _pending: undefined }; await saveEmbeddingApi(); }
      renderSettingsBody();
      toast('已应用导入的 API 设置');
    });
    body.querySelectorAll('[data-preset-apply]').forEach((b) => b.addEventListener('click', async () => {
      const p = apiPresets[Number(b.dataset.presetApply)];
      if (!p) return;
      // 预设存的时候 key 是 undefined，直接展开会把已保存的 Key 抹成 undefined。
      // 预设本来就不含 Key：去掉它，保留当前 Key。
      const { key: _pk, ...presetNoKey } = p;
      void _pk;
      apiSettings = { ...apiSettings, ...presetNoKey, _pending: undefined };
      await saveApiSettings();
      renderSettingsBody();
      toast('已应用预设');
    }));
    body.querySelectorAll('[data-preset-del]').forEach((b) => b.addEventListener('click', async () => {
      apiPresets.splice(Number(b.dataset.presetDel), 1);
      await backend.put('settings', { key: 'apiPresets', value: apiPresets });
      renderSettingsBody();
    }));
    $('#preset-save').addEventListener('click', async () => {
      const cfg = readApiForm();
      apiPresets.push({ name: `${cfg.provider} · ${cfg.model || '未命名'}`, ...cfg, key: undefined });
      await backend.put('settings', { key: 'apiPresets', value: apiPresets });
      renderSettingsBody();
      toast('预设已保存（不含 Key）');
    });
    bindAuxApiSection('summary');
    bindAuxApiSection('embedding');
    return;
  }

  if (settingsTab === 'data') {
    const sup = char.supersededRounds || [];
    body.innerHTML = `
      <h3>导入 / 导出</h3>
      <p class="muted">支持 JSON 与 gzip / zlib / ZIP / UTF-16 / base64 包装的 .ee；按文件实际内容识别格式，不看扩展名。导入前会预览数量并让你选主角色，不会删除未选数据。</p>
      <div class="actions-row">
        <button class="primary" id="data-export">导出 JSON</button>
        <button id="data-export-ee">导出 .ee（压缩）</button>
        <button id="data-import">导入备份…</button>
      </div>
      <div id="import-drop" class="drop-zone">也可以把备份文件直接拖到这里</div>
      <details class="paste-import"><summary>粘贴 JSON 文本导入</summary>
        <textarea id="import-paste" rows="4" placeholder="把备份 JSON 文本粘贴到这里"></textarea>
        <div class="actions-row"><button id="data-import-paste">用粘贴的文本导入</button></div>
      </details>
      <div class="setting-row"><span class="setting-label">导出时包含 API Key<small>默认不含；勾选后请妥善保管</small></span><label class="switch"><input type="checkbox" id="export-keys"><span class="switch-track"></span></label></div>
      <input type="file" id="import-file" class="file-input-hidden">
      <div id="import-report"></div>
      <h3>被替换的回复（可恢复）</h3>
      <div id="sup-list">${sup.map((r, i) => `
        <div class="list-item"><strong>第 ${i + 1} 次替换</strong> <span class="muted">${esc(formatTimeDivider(r.at))} · ${r.messages.length} 条气泡</span>
        <div class="actions-row"><button data-sup-restore="${i}">恢复这一轮</button><button data-sup-del="${i}">删除</button></div></div>`).join('') || '<p class="muted">暂无被替换的回复。</p>'}</div>
      <h3>自检</h3>
      <p class="muted">跑纯逻辑检查 + 3 万条合成消息分页检查（用临时角色，跑完清理，不混入真实聊天）。</p>
      <div class="actions-row"><button id="data-selftest">运行自检</button></div>
      <div id="selftest-result"></div>
      <h3>向量记忆 / MCP</h3>
      <p class="muted">向量检索已接入：记忆页可建立索引、测试召回、调整阈值；聊天时按相关性召回记忆进请求。MCP 仅保留模块边界，本阶段不提供入口。</p>
      <h3>示例数据</h3>
      ${char.isSample ? '<p class="muted">当前是示例角色（可删除）。导入备份后可在导入预览里选主角色。</p>' : ''}
      <div class="actions-row"><button id="data-delete-char" class="danger">删除当前角色（含全部消息）</button></div>`;
    $('#data-export').addEventListener('click', () => doExport(false));
    $('#data-export-ee').addEventListener('click', () => doExport(true));
    $('#data-import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (f) handleImportFile(f);
    });
    const drop = $('#import-drop');
    if (drop) {
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault(); drop.classList.remove('drag-over');
        const f = e.dataTransfer?.files?.[0];
        if (f) handleImportFile(f);
      });
    }
    $('#data-import-paste')?.addEventListener('click', () => {
      const text = document.getElementById('import-paste')?.value || '';
      if (!text.trim()) { toast('先粘贴备份 JSON 文本'); return; }
      handleImportText(text, '粘贴的文本');
    });
    body.querySelectorAll('[data-sup-restore]').forEach((b) => b.addEventListener('click', async () => {
      const r = sup[Number(b.dataset.supRestore)];
      if (!r) return;
      for (const m of r.messages) await backend.put('messages', m);
      char.supersededRounds.splice(Number(b.dataset.supRestore), 1);
      await saveCharacter();
      await renderMessages(false);
      renderSettingsBody();
      toast('已恢复上一轮回复');
    }));
    body.querySelectorAll('[data-sup-del]').forEach((b) => b.addEventListener('click', async () => {
      char.supersededRounds.splice(Number(b.dataset.supDel), 1);
      await saveCharacter();
      renderSettingsBody();
    }));
    $('#data-selftest').addEventListener('click', runSelfTest);
    $('#data-delete-char').addEventListener('click', async () => {
      if (!confirm(`确定删除「${char.remarkName || char.realName}」的全部数据吗？建议先导出备份。`)) return;
      const id = char.id;
      await backend.delete('characters', id);
      const msgs = await backend.getAllMessages(id);
      for (const m of msgs) await backend.delete('messages', m.id);
      const j = await backend.getAll('journals');
      for (const x of j.filter((v) => v.charId === id)) await backend.delete('journals', x.id);
      // 检索残留一起清：该角色的经历、关键词索引与向量段（cleanupCharacterRetrievalData）。
      await cleanupCharacterRetrievalData(backend, id);
      localStorage.removeItem('uwu-chat.lastChar');
      location.reload();
    });
    return;
  }

  if (settingsTab === 'context') {
    body.innerHTML = `
      <p class="muted">本次发送会带给模型的内容（与 Get Reply 共用同一份构建结果，历史或设置一变就重建）。</p>
      <div id="ctx-body"><p class="muted">正在构建…</p></div>
      <div class="actions-row"><button class="primary" id="ctx-preview">本次发送内容预览</button></div>`;
    const renderCtx = async () => {
      try {
        const built = await buildCurrentRequest();
        const receipts = await getAssocReceipts(backend).catch(() => []);
        const msgs = built.req.body?.messages || [];
        const rows = msgs.map((m) => `<tr><td>${escapeHtml(m.role)}</td><td>${escapeHtml(String(m.content || '').slice(0, 120))}</td></tr>`).join('');
        $('#ctx-body').innerHTML = `
          <div class="kv"><span>提示词版本</span><b>${escapeHtml(built.sys.version || '')}</b></div>
          <div class="kv"><span>消息条数</span><b>${msgs.length}</b></div>
          <div class="kv"><span>预估 token</span><b>${countTextTokens(JSON.stringify(msgs))}</b></div>
          <h3>本次真正加入请求的记忆</h3>
          ${built.retrievalError ? `<p style="color:#b0442f">记忆检索失败：${escapeHtml(built.retrievalError)}（已继续正常聊天，本次没有召回记忆）</p>` : ''}
          ${memorySectionsHTML(built.memorySections, receipts)}
          <p class="muted">固定注入的收藏记忆见提示词模块「收藏记忆」，不在此重复列出。</p>
          <table class="preview-table">${rows}</table>
          <p class="muted">${built.reused ? '直接复用刚才的构建，未重新构建' : '本次新构建'}</p>`;
      } catch (e) {
        $('#ctx-body').innerHTML = `<p class="err">构建失败：${escapeHtml(e.message || '')}</p>`;
      }
    };
    $('#ctx-preview').addEventListener('click', showSendPreview);
    renderCtx();
    return;
  }

  if (settingsTab === 'mcp') {
    body.innerHTML = `
      <div class="card"><p class="muted">MCP 尚未接入。本阶段只保留模块边界，不提供入口、不模拟连接状态。</p></div>
      <p class="muted">向量记忆见「记忆」页：建立索引后，聊天时会按相关性召回记忆进请求；收藏的记忆固定注入，召回的记忆是另外的独立区域。</p>`;
    return;
  }

  if (settingsTab === 'notify') {
    body.innerHTML = '<div id="b-notify-sec"></div><div id="b-keepalive-sec"></div><div id="b-push-sec"></div><div id="b-wake-sec"></div>';
    renderNotifySettingsSection(document.getElementById('b-notify-sec'), {
      settings: notifySettings,
      onSave: async (next) => { notifySettings = next; if (inAppNotifier) inAppNotifier.settings = { ...inAppNotifier.settings, ...next }; await saveNotifySettings(); },
      toast,
    });
    renderKeepAliveSettingsSection(document.getElementById('b-keepalive-sec'), {
      settings: keepAliveSettings,
      keepAlive: audioKeepAlive,
      onSave: async (next) => { keepAliveSettings = next; await saveKeepAliveSettings(); },
      onStateChange: () => renderSettingsBody(),
      toast,
    });
    renderPushSettingsSection(document.getElementById('b-push-sec'), {
      settings: pushSettings,
      env: {
        hasServiceWorker: 'serviceWorker' in navigator,
        hasPushManager: 'PushManager' in window,
        hasNotification: 'Notification' in window,
        permission: ('Notification' in window) ? Notification.permission : 'unsupported',
        configured: !!(pushSettings.vapidPublicKey && pushSettings.pushServiceUrl),
        tested: false,
        isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent),
        isStandalone: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
      },
      onSave: async (next) => { pushSettings = next; await savePushSettings(); },
      onRequestPermission: () => requestPermission(),
      onSubscribe: async () => {
        const reg = await navigator.serviceWorker?.getRegistration?.();
        if (!reg) return { ok: false, reason: 'Service Worker 未注册。' };
        return subscribePush(reg, pushSettings.vapidPublicKey);
      },
      toast,
    });
    renderWakeSettingsSection(document.getElementById('b-wake-sec'), {
      settings: wakeSettings,
      chars: [{ id: char.id, name: char.remarkName || char.realName }],
      onSave: async (next) => { wakeSettings = next; if (wakeEngine) await wakeEngine.saveSettings(next); await saveWakeSettings(); },
      toast,
    });
    return;
  }

  if (settingsTab === 'appearance') {
    ThemeStore.renderAppearance(body);
    const iconHost = document.createElement('div');
    iconHost.id = 'b-icon-sec';
    body.appendChild(iconHost);
    renderIconSettingsSection(iconHost, {
      settings: customIconSettings,
      onSave: async (record) => {
        // renderIconSettingsSection 渲染时快照的 dataUrl 可能已过期（文件选择后
        // 才读入新图）：以当前 customIconSettings.dataUrl 为准补齐。
        const nextSettings = { appName: record.appName, dataUrl: record.dataUrl || customIconSettings.dataUrl };
        // 取源图：内存里的当前源图优先，否则解码已存的小图。
        let src = customIconSourceImage;
        if (!src && customIconSettings.dataUrl) {
          src = await loadIconImage(customIconSettings.dataUrl).catch(() => null);
        }
        if (!src) {
          // 只改了应用名、没传图：本地保存 + 改标题即可，不上传、不刷新。
          customIconSettings = nextSettings;
          await saveCustomIconSettings();
          document.title = nextSettings.appName || DEFAULT_APP_NAME;
          toast('应用名称已保存（图标未变）');
          return;
        }
        // 512×512 master：先填白底再画裁切图（iOS 会把透明按黑色合成，
        // 先烤白底是确定的），再转 PNG Blob 上传服务端。
        const master = document.createElement('canvas');
        master.width = 512; master.height = 512;
        const mctx = master.getContext('2d');
        mctx.fillStyle = '#ffffff';
        mctx.fillRect(0, 0, 512, 512);
        const crop = computeCropRect(src.width, src.height);
        mctx.drawImage(src, crop.x, crop.y, crop.size, crop.size, 0, 0, 512, 512);
        const blob = await new Promise((resolve, reject) => {
          master.toBlob((b) => (b ? resolve(b) : reject(new Error('生成图标图片失败'))), 'image/png');
        });
        let uploaded;
        try {
          uploaded = await uploadCustomIcon(blob);
        } catch (err) {
          // 上传失败：明确报错，不改本地版本、不保存设置、不 reload。
          toast(`图标上传失败：${err?.message || '服务端不可用'}（本地设置未改动）`);
          throw err;
        }
        customIconSettings = nextSettings;
        try { localStorage.setItem(CUSTOM_ICON_VERSION_KEY, uploaded.version); } catch { /* 忽略 */ }
        applyCustomIconUrl(uploaded.url || buildCustomIconVersionedUrl(uploaded.version));
        await saveCustomIconSettings();
        document.title = nextSettings.appName || DEFAULT_APP_NAME;
        toast('已应用，刷新后重新添加到主屏幕就能看到新图标');
        // 刷新让 Safari 在加载时抓新图标；刷新是站内行为，不算重新部署。
        location.reload();
      },
      onRestoreDefault: async () => {
        // 删服务端图标：失败也继续本地清理，但 toast 要说明服务端可能没清掉。
        let serverCleared = true;
        try { await deleteCustomIcon(); } catch { serverCleared = false; }
        try { localStorage.removeItem(CUSTOM_ICON_VERSION_KEY); } catch { /* 忽略 */ }
        applyCustomIconUrl('/apple-touch-icon.png');
        customIconSettings = { appName: DEFAULT_APP_NAME, dataUrl: null };
        await saveCustomIconSettings();
        document.title = 'verweile';
        toast(serverCleared
          ? '已恢复默认图标，刷新后重新添加到主屏幕即可看到默认图标'
          : '已恢复本地默认图标，但服务端可能没清掉旧图标（可稍后重试恢复默认）');
        location.reload();
      },
      onExportPack: async () => {
        // 真实导出：用当前源图调 exportIconPack 逐档生成 PNG 并触发下载。
        let src = customIconSourceImage;
        if (!src && customIconSettings.dataUrl) {
          src = await loadIconImage(customIconSettings.dataUrl).catch(() => null);
        }
        if (!src) return { ok: false, reason: '没有可用的源图，请先上传一张图标图片。' };
        const pack = exportIconPack((size) => {
          const canvas = document.createElement('canvas');
          canvas.width = size; canvas.height = size;
          return { canvas, ctx: canvas.getContext('2d') };
        }, src, customIconSettings.appName);
        if (!pack.ok) return pack;
        for (const f of pack.files) {
          const a = document.createElement('a');
          a.href = f.dataUrl; a.download = f.file; a.click();
        }
        toast(`图标包已下载（${pack.files.length} 个文件：180 / 192 / 512 / maskable）`);
        return pack;
      },
      toast,
    });
    // 图标文件选择回调（renderIconSettingsSection 只渲染界面，不直接读文件）：
    // validateIconFile → 读图 → computeCropRect / previewSpecs 画预览 →
    // 压缩后 data URL 存 customIconSettings.dataUrl。
    iconHost.querySelector('#icon-file')?.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      try { await handleIconFileChange(f); } catch (err) { toast(err?.message || '读取图标失败'); }
    });
    return;
  }

  if (settingsTab === 'tokens') {
    ManageView.renderTokensPage(body);
    return;
  }
}

async function doExport(asEe) {
  try {
    const includeKeys = document.getElementById('export-keys')?.checked ?? false;
    const data = await exportAll(backend, { includeKeys });
    let name = `verweile-backup-${new Date().toISOString().slice(0, 10)}.${asEe ? 'ee' : 'json'}`;
    let blob;
    if (asEe) {
      const json = JSON.stringify(data, null, 2);
      try {
        blob = new Blob([await gzipBytes(json)], { type: 'application/gzip' });
      } catch (e) {
        // 旧环境压不了 gzip 就改导 JSON，别让导出直接失败
        console.warn(e);
        blob = new Blob([json], { type: 'application/json' });
        name = name.replace(/\.ee$/, '.json');
        toast('当前环境不支持 gzip 压缩，已改导 JSON 备份');
      }
    } else {
      blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`已导出 ${name}${includeKeys ? '（包含 Key，请妥善保管）' : '（不含 Key）'}`);
  } catch (e) {
    console.warn(e);
    showModal('导出失败', `<p>${escapeHtml(e.message || '未知错误')}</p><p class="muted">可以重试，或检查浏览器存储权限。</p>`, [{ label: '关闭' }]);
  }
}

async function handleImportFile(file) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    await handleImportBytes(buf, file.name);
  } catch (e) {
    console.warn(e);
    showImportFailure(file.name, null, e);
  }
}

async function handleImportText(text, label) {
  try {
    await handleImportBytes(new TextEncoder().encode(text), label || '粘贴的文本');
  } catch (e) {
    console.warn(e);
    showImportFailure(label || '粘贴的文本', new TextEncoder().encode(text), e);
  }
}

/** 导入失败时把文件名、大小、文件头和错误都摊开，方便截图反馈是哪一步卡住。 */
function showImportFailure(name, bytes, err) {
  const info = bytes ? describeBackupBytes(bytes, name) : null;
  showModal('导入失败', `
    <p>文件：${escapeHtml(name || '（未知）')}${info ? `（${info.size} 字节，识别为 ${escapeHtml(info.format)}）` : ''}</p>
    ${info ? `<p class="muted">文件头：${escapeHtml(info.headHex)}</p><p class="muted">开头内容：${escapeHtml(info.headText || '（无法显示）')}</p>` : ''}
    <p>错误：${escapeHtml(err?.message || '文件解析错误')}</p>
    <p class="muted">把这页截个图发我，我就知道是哪里卡住了。也可以先试试导出一份 JSON 再导回来。</p>`,
  [{ label: '关闭' }]);
}

async function handleImportBytes(buf, label) {
  try {
    const { text, format } = await decodeBackupBytes(buf);
    const raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  const norm = normalizeBackup(raw);
  const counts = previewCounts(norm);
  const chars = norm.characters;
  const formatLabel = { gzip: '.ee 压缩包', zlib: 'zlib 压缩包', utf16: 'UTF-16 文本', json: 'JSON', base64: 'base64 包装' }[format]
    || (format.startsWith('zip:') ? `ZIP 包（${format.slice(4)}）` : format);
  showModal('导入预览', `
      <p>文件：${escapeHtml(label || '')}（${escapeHtml(formatLabel)}）</p>
      <table class="preview-table">
        <tr><td>角色</td><td>${counts.characters.length} 个（${esc(counts.characters.map((c) => c.remarkName || c.realName || '未命名').join('、'))}）</td></tr>
        <tr><td>消息</td><td>${counts.messages}</td></tr>
        <tr><td>世界书</td><td>${counts.worldBooks}</td></tr>
        <tr><td>记忆</td><td>${counts.journals}</td></tr>
        <tr><td>经历</td><td>${counts.experiences}</td></tr>
        <tr><td>表情包</td><td>${counts.stickers}</td></tr>
        ${counts.gaps.length ? `<tr><td>待接入</td><td>${escapeHtml(counts.gaps.join('、'))}</td></tr>` : ''}
      </table>
      <label>主角色（进入提示词与聊天）</label>
      <select id="import-main-char">${chars.map((c, i) => `<option value="${i}">${esc(c.remarkName || c.realName || '未命名')}</option>`).join('')}</select>
      <label>导入方式</label>
      <select id="import-mode"><option value="merge">合并（默认，不覆盖已有数据）</option><option value="replace">替换全部数据（先清空现有库，再导入）</option></select>
      ${norm.apiSettings || norm.summaryApi || norm.embeddingApi ? '<p class="notice">备份含 API 设置：导入后只保存非 Key 字段待你确认，Key 需在设置里单独填写。</p>' : ''}`,
    [
      { label: '取消' },
      { label: '开始导入', primary: true, onClick: async () => {
        const mainIdx = parseInt(document.getElementById('import-main-char')?.value || '0', 10);
        const mode = document.getElementById('import-mode')?.value || 'merge';
        const mainId = norm.characters[mainIdx]?.id || null;
        const report = await importNormalized(backend, norm, { mainCharacterId: mainId, mode });
        if (norm.apiSettings) {
          const { key, ...rest } = norm.apiSettings;
          void key;
          apiSettings = { ...apiSettings, _pending: rest };
          await saveApiSettings();
        }
        // 副 API 配置同样只留非 Key 字段待确认，Key 永不随导入恢复。
        if (norm.summaryApi) {
          summaryApi = { ...summaryApi, ...withoutKey(norm.summaryApi), _pending: withoutKey(norm.summaryApi) };
          await saveSummaryApi();
        }
        if (norm.embeddingApi) {
          embeddingApi = { ...embeddingApi, ...withoutKey(norm.embeddingApi), _pending: withoutKey(norm.embeddingApi) };
          await saveEmbeddingApi();
        }
        if (mainId) localStorage.setItem('uwu-chat.lastChar', mainId);
        await loadAll();
        updateHeader();
        await renderMessages(false);
        const skippedTotal = Object.values(report.skipped || {}).reduce((s, n) => s + (n || 0), 0);
        const rep = $('#import-report');
        if (rep) rep.innerHTML = `<div class="notice">导入完成：新增 ${report.added.characters || 0} 个角色、${report.added.messages || 0} 条消息、${report.added.worldBooks || 0} 本世界书、${report.added.journals || 0} 条记忆、${report.added.experiences || 0} 条经历、${report.added.stickers || 0} 个表情包；跳过重复 ${skippedTotal} 条${report.conflicts.length ? `；冲突 ${report.conflicts.length} 条：${escapeHtml(report.conflicts[0] || '')}` : ''}${(report.unknownPreserved || []).length ? `；待接入（原样保存）：${escapeHtml(report.unknownPreserved.join('、'))}` : ''}。</div>`;
        toast('导入完成');
      } },
    ]);
  } catch (e) {
    console.warn(e);
    showImportFailure(label, buf, e);
  }
}

/** 记忆三区块给预览看的 HTML：上下文预览（renderCtx）与“本次发送内容预览”
 * （showSendPreview）共用同一份 built.memorySections，所以预览显示的与实际
 * 发送的完全一致。receipts 是回执记录（getAssocReceipts），用来显示三态里的
 * “回复实际提及”（有回执显示 mentioned/unused，没有显示“待回复后结算”）。
 * 每条注入显示标题、完整原文（截断时明确标注）、出处（来源 + 日期 + docId）与
 * 召回路径；已检索未注入的（无出处/校验失败/预算跳过）也如实列出原因。 */
function memorySectionsHTML(sections, receipts = []) {
  if (!sections) return '<p class="muted">本次没有注入记忆区块。</p>';
  const out = [];
  if (sections.injectedIntoPrompt === false) {
    out.push('<p class="notice">当前使用了自定义覆盖层提示词，以下记忆区块没有进入系统提示词（只展示本次构建的结果）。</p>');
  }
  // ②阶段背景
  out.push('<h3>阶段背景</h3>');
  if (!sections.stage.items.length) {
    out.push('<p class="muted">本次没有阶段总结记忆。</p>');
  } else {
    out.push(sections.stage.items.map((j) => `
      <div class="mem-block"><strong>${esc(j.title)}</strong>
      <span class="muted">${esc(j.date || '')}${j.date ? ' · ' : ''}${esc(j.source || '')} · docId：${esc(j.docId)}</span>
      ${j.sourceStatus === 'unsourced' ? '<span class="muted">（无原文出处，仅作阶段背景参考，不可当作原话引用）</span>' : '<span class="muted">（有原文出处）</span>'}
      <pre class="code">${esc(j.content)}</pre></div>`).join(''));
  }
  // ③检索证据（已注入）+ 邻居
  out.push('<h3>检索证据（已注入）</h3>');
  if (!sections.evidence.items.length) {
    out.push('<p class="muted">本次没有进入检索证据区的记忆（未开启、未配置、未建索引，或没有达到阈值的记忆）。</p>');
  } else {
    out.push(sections.evidence.items.map((m) => `
      <div class="mem-block"><strong>${esc(m.title)}</strong> <span class="muted">已注入</span>
      <span class="muted">${esc(m.retrievalPath || '')}${m.date ? ` · ${esc(m.date)}` : ''} · ${esc(m.source || '')} · docId：${esc(m.docId)}</span>
      ${m.alsoAssoc ? '<span class="muted">（联想亦选中）</span>' : ''}
      ${m.truncated ? '<span class="muted">（已按 Token 预算截断，只注入了前一部分）</span>' : ''}
      <pre class="code">${esc(m.injectedText || m.content || '')}</pre>
      ${(m.neighbors || []).map((n) => `
        <div class="mem-block"><span class="muted">相邻对话（补充上下文，非独立证据；${n.roundOffset < 0 ? '上一轮' : n.roundOffset > 0 ? '下一轮' : '同轮'}${n.speaker ? ` · ${esc(n.speaker)}` : ''}${n.timestamp ? ` · ${esc(formatEvidenceTime(n.timestamp))}` : ''}）</span>
        <pre class="code">${esc(n.content || '')}</pre></div>`).join('')}
      </div>`).join(''));
  }
  // ④联想旧事
  out.push('<h3>联想旧事</h3>');
  const assoc = sections.assoc || {};
  if (assoc.status === 'in-evidence' && assoc.item) {
    out.push(`<p>「${esc(assoc.item.title)}」已在检索证据里，不重复注入（联想亦选中）。用法：${assoc.item.use === 'mention' ? '回复里可以顺口自然提到' : '只作背景理解、不要主动提起'}。${assoc.item.reason ? `副模型原因：${esc(assoc.item.reason)}` : ''}</p>`);
  } else if (assoc.status === 'injected' && assoc.item) {
    const receipt = latestReceiptForExp(receipts, assoc.item.docId);
    const state = receipt
      ? (receipt.mentioned ? '回复实际提及：已提及' : '回复实际提及：已注入，未提及')
      : '待回复后结算';
    out.push(`<div class="mem-block"><strong>${esc(assoc.item.title)}</strong> <span class="muted">已注入 · ${state}</span>
      <span class="muted">用法：${assoc.item.use === 'mention' ? '回复里可以顺口自然提到（也可以不提）' : '只作背景理解、不要主动提起'}${assoc.item.date ? ` · ${esc(assoc.item.date)}` : ''} · ${esc(assoc.item.source || '')} · docId：${esc(assoc.item.docId)}</span>
      ${assoc.item.reason ? `<p class="muted">副模型原因：${esc(assoc.item.reason)}</p>` : ''}
      ${(assoc.item.clues || []).map((c) => `<p>线索：${esc(c.text)}${c.excerpt ? `（原文「${esc(c.excerpt)}」）` : ''}</p>`).join('')}
      ${(assoc.item.quotes || []).map((q) => `<p>关键原话：「${esc(q.text)}」${q.speaker ? ` —— ${esc(q.speaker)}` : ''}</p>`).join('')}
      ${assoc.item.truncated ? '<span class="muted">（已按 Token 预算截断）</span>' : ''}
      </div>`);
  } else if (assoc.status === 'dropped') {
    const d = (sections.dropped || []).find((x) => x.where === 'assoc');
    out.push(`<p class="muted">联想选中的经历未注入${d ? `：${esc(d.reason)}` : ''}。</p>`);
  } else {
    out.push('<p class="muted">本轮没有联想选中。</p>');
  }
  // 预算跳过与丢弃（已检索，未注入）
  if ((sections.skippedByBudget || []).length) {
    out.push(`<p class="muted">因预算跳过 ${sections.skippedByBudget.length} 条：${esc(sections.skippedByBudget.map((x) => `${x.title || x.docId}（${{ evidence: '检索证据', neighbor: '相邻对话', assoc: '联想旧事' }[x.kind] || x.kind}）`).join('、'))}</p>`);
  }
  if ((sections.dropped || []).length) {
    out.push(`<h3>已检索、未注入</h3>` + sections.dropped.map((d) => `<p class="muted">「${esc(d.title || d.docId)}」（${{ evidence: '检索证据', stage: '阶段背景', assoc: '联想旧事', neighbor: '相邻对话' }[d.where] || d.where}）：${esc(d.reason)}</p>`).join(''));
  }
  return out.join('');
}

async function showSendPreview() {
  try {
    const { sys, req, reused, retrieved = [], retrievalError = null } = await buildCurrentRequest();
    const receipts = await getAssocReceipts(backend).catch(() => []);
    const msgs = req.body.messages || req.body.contents || [];
    const tokens = sys.tokenEstimate + countTextTokens(JSON.stringify(msgs));
    const sysText = req.systemPrompt || sys.systemPrompt;
    const retrievedTokens = countTextTokens(retrieved.map((m) => m.content || '').join('\n'));
    showModal('本次发送内容预览', `
      <p class="muted">与 Get Reply 发送的是同一份构建结果（${reused ? '直接复用刚才的构建，未重新构建' : '本次新构建'}）；API Key 不显示。</p>
      <table class="preview-table">
        <tr><td>服务商</td><td>${esc(apiSettings.provider || 'openai')}</td></tr>
        <tr><td>模型</td><td>${esc(apiSettings.model || '（未填）')}</td></tr>
        <tr><td>提示词版本</td><td>${esc(sys.version)}</td></tr>
        <tr><td>消息数（请求内）</td><td>${msgs.length} 条（历史 ${req.stats.historyMessages} 条，进请求前已按 maxMemory ${req.stats.maxMemory} 截断；不进上下文 ${req.stats.droppedContextDisabled} 条）</td></tr>
        <tr><td>Token（估算）</td><td>约 ${tokens}（估算值，非官方计费口径）</td></tr>
        <tr><td>向量召回记忆</td><td>${retrievalError ? `检索失败：${esc(retrievalError)}（已继续，本次无召回）` : retrieved.length ? `${retrieved.length} 条，约 ${retrievedTokens} token：${esc(retrieved.map((m) => `${m.title || '未命名'}（${m.score.toFixed(2)}）`).join('、'))}` : '本次无召回'}</td></tr>
      </table>
      <label>模块来源（Token 估算）</label>
      <table class="preview-table">${sys.modules.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.source)}</td><td>约 ${m.tokens}</td></tr>`).join('')}</table>
      <label>记忆区块（本次真正注入，与实际发送一致）</label>
      ${memorySectionsHTML(sys.memorySections, receipts)}
      <label>System Prompt</label>
      <textarea rows="8" readonly>${esc(sysText)}</textarea>
      <label>消息列表</label>
      <pre class="code">${escapeHtml(msgs.map((m, i) => `${i + 1}. [${m.role || m.role}] ${JSON.stringify(m.content ?? m.parts ?? m)}`).slice(0, 40).join('\n'))}${msgs.length > 40 ? '\n…（已省略后续）' : ''}</pre>`,
    [{ label: '关闭' }]);
  } catch (e) {
    toast('预览失败：' + (e.message || ''));
  }
}

/* ---------------- 自检 ---------------- */
async function runSelfTest() {
  const box = $('#selftest-result');
  box.innerHTML = '<p class="muted">正在自检…</p>';
  const results = [];
  const check = (name, ok, note) => results.push({ name, ok: !!ok, note: note || '' });
  try {
    // 1. TT 生效 + 去重
    const sys = buildSystemPrompt(char, { worldBooks, stickers, globalSettings });
    const effVersion = resolvePromptVersion(char, globalSettings);
    check('提示词版本解析（角色专属优先，其次全局 cotSettings）', sys.version === effVersion, `当前生效 ${effVersion}`);
    check(effVersion === 'tt' ? 'TT 模板生效' : 'UWU 模板生效',
      effVersion === 'tt' ? sys.systemPrompt.includes('在线聊天的感觉') : sys.systemPrompt.includes('共同回忆'));
    check('提示词不含小动态/商城等未实现能力', !/小动态|商城|代付/.test(sys));
    // 有更早历史时：3 条连发只进一次请求，chat_history 恰好 1 次。
    const hist = [
      { id: 'm0', role: 'assistant', content: '[角色的消息：早]', timestamp: 500 },
      { id: 'a', role: 'user', content: '[我的消息：你好]', timestamp: 1000 },
      { id: 'b', role: 'user', content: '[我的消息：你在吗]', timestamp: 2000 },
      { id: 'c', role: 'user', content: '[我的消息：回我]', timestamp: 3000 },
    ];
    const req = buildRequest(char, hist, sys, { provider: 'openai' });
    const ui = JSON.stringify(req.body.messages).match(/<user_input>/g)?.length || 0;
    const ch = JSON.stringify(req.body.messages).match(/<chat_history>/g)?.length || 0;
    check('3 条用户消息只进入一次请求（user_input 1 次）', ui === 1, `实际 ${ui} 次`);
    check('chat_history 恰好出现 1 次', ch === 1, `实际 ${ch} 次`);
    // 只有最新一轮时：不发空的 chat_history（之前这条自检用的全是用户消息，
    // 按正确行为 chat_history 该是 0 次，旧断言写错了）。
    const req0 = buildRequest(char, hist.slice(1), sys, { provider: 'openai' });
    const ch0 = JSON.stringify(req0.body.messages).match(/<chat_history>/g)?.length || 0;
    check('只有最新一轮时不发空 chat_history', ch0 === 0, `实际 ${ch0} 次`);
    // 2. 解析
    const segs = parseReplyText('[角色的消息：嗨「Hello」]', char, { allowedStickers: [] });
    check('双语解析', segs[0]?.kind === 'bilingual');
    const segs2 = parseReplyText('[角色的消息：[表情包：不存在的名字]]', char, { allowedStickers: [] });
    check('未知表情包回退为文字', segs2[0]?.kind === 'stickerUnknown' || segs2[0]?.kind === 'text');
    // 3. 3 万条分页
    const synthId = 'char_selftest_synth';
    await backend.put('characters', { id: synthId, realName: '自检临时', isSample: true });
    const batch = [];
    const t0 = Date.now();
    for (let i = 0; i < 30000; i++) {
      batch.push({ id: `synth_${i}`, charId: synthId, role: i % 2 ? 'user' : 'assistant', content: `[消息：合成 ${i}]`, timestamp: 1000 + i });
      if (batch.length === 1000) { await backend.putMany('messages', batch.splice(0)); }
    }
    if (batch.length) await backend.putMany('messages', batch);
    const page = await backend.getMessagesPage(synthId, { before: Infinity, limit: PAGE_SIZE });
    const cnt = await backend.countMessages(synthId);
    check('3 万条写入后分页取 50 条', page.messages.length === 50 && cnt === 30000, `共 ${cnt} 条，耗时约 ${Date.now() - t0}ms`);
    const reqSynth = buildRequest(char, await backend.getAllMessages(synthId), sys, { provider: 'openai' });
    const synthUi = JSON.stringify(reqSynth.body.messages).match(/<user_input>/g)?.length || 0;
    check('3 万条上下文只取尾部 80 条进请求', synthUi === 1);
    // 清理
    const allSynth = await backend.getAllMessages(synthId);
    for (let i = 0; i < allSynth.length; i += 1000) {
      await Promise.all(allSynth.slice(i, i + 1000).map((m) => backend.delete('messages', m.id)));
    }
    await backend.delete('characters', synthId);
    check('自检临时数据已清理', (await backend.countMessages(synthId)) === 0);
  } catch (e) {
    check('自检异常', false, e.message);
  }
  box.innerHTML = results.map((r) => `<div class="check-row ${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✗'} ${escapeHtml(r.name)}${r.note ? `（${escapeHtml(r.note)}）` : ''}</div>`).join('')
    + `<p class="muted">完整单元测试在源码里跑：npm test。真实 API 端到端需你填 Key 后验证。</p>`;
}

/* ---------------- 启动 ---------------- */
/* ---------------- B 组：站内横幅 + 唤醒回合 ---------------- */

/** 是否正在看聊天页：以 NavShell 的当前页状态为准，不凭空编 DOM id。 */
function isChatPageVisible() {
  return NavShell.getCurrent() === 'chat' && !document.hidden;
}

/** 单角色现状：头像/昵称取当前角色；不是当前角色时返回空。 */
async function charAvatarFor(charId) {
  if (!char || char.id !== charId) return '';
  try { return await resolveAvatar(char.avatar); } catch { return ''; }
}
function charNameFor(charId) {
  if (!char || char.id !== charId) return '';
  return char.remarkName || char.realName || '';
}
/** 横幅摘要用的纯文本（去协议前缀，取原文）。 */
function plainTextOf(msg) {
  return extractProtocolText(messageText(msg)) || msg.content || '';
}

// B 组：站内横幅渲染（按 InAppNotifier 返回的 banner 描述子渲染；CSS 见 styles.css 的 B-group block）。
function renderInAppBanner(banner) {
  document.querySelector('.inapp-banner')?.remove();
  const el = document.createElement('div');
  el.className = 'inapp-banner';
  el.innerHTML = `${banner.avatar ? `<img class="inapp-banner-avatar" src="${escapeHtml(banner.avatar)}" alt="">` : ''}
    <div class="inapp-banner-body"><div class="inapp-banner-name">${escapeHtml(banner.nickname)}</div>
    <div class="inapp-banner-summary">${escapeHtml(banner.summary)}</div></div>
    <button class="inapp-banner-close" aria-label="关闭通知">×</button>`;
  el.addEventListener('click', () => { el.remove(); inAppNotifier?.openBanner(banner.id); });
  el.querySelector('.inapp-banner-close').addEventListener('click', (e) => {
    e.stopPropagation(); el.remove(); inAppNotifier?.dismissBanner(banner.id);
  });
  document.getElementById('app')?.appendChild(el);
  setTimeout(() => { el.remove(); inAppNotifier?.dismissBanner(banner.id); }, 8000); // 8 秒自动消失，未读照计
}

/** 点横幅进聊天：切到聊天页并定位到 messageId（不生成新消息）；单角色现状下等价于回到聊天页。
 *  定位走 jumpToMessage（与搜索/收藏/日期共用同一套逻辑）；定位失败时落到底部。 */
async function openChatForBanner(charId, messageId) {
  NavShell.switchView('chat');
  if (inAppNotifier) { inAppNotifier.markRead(charId); await saveUnread(backend, inAppNotifier).catch(() => {}); }
  if (!messageId) { messageArea.scrollTop = messageArea.scrollHeight; return; }
  const ok = await jumpToMessage(messageId);
  if (!ok) messageArea.scrollTop = messageArea.scrollHeight;
}

/**
 * 唤醒回合的模型决策解析（纯函数）：模型回复第一行只能是
 * 【发送】/【跳过】/【调整】其一；【发送】后跟要发的内容，
 * 【调整】后跟一个唤醒工具调用 JSON（走 parseWakeToolCall 校验）。
 * 解析不出决策时返回 unknown，调用方按 skip 处理，绝不凭空发消息。
 */
function parseWakeDecision(raw) {
  const text = String(raw || '').trim();
  const head = text.match(/^【(发送|跳过|调整)】/);
  if (!head) return { decision: 'unknown', reason: '模型回复没有以【发送】/【跳过】/【调整】开头' };
  const rest = text.slice(head[0].length).trim();
  if (head[1] === '发送') return { decision: 'send', message: rest };
  if (head[1] === '跳过') return { decision: 'skip' };
  return { decision: 'reschedule', toolCall: rest };
}

/**
 * 唤醒回合执行（B 组 §8.6）：checkDueOnForeground 返回 due 项后逐项执行，
 * 复用现有“生成回复并保存”的链路（buildCurrentRequest + sendChat +
 * handleAiReplyContent），不另起一套保存逻辑。
 * 顺序：先 handleWakeOutcome 校验并收尾（用户中途发言时返回 cancelled，
 * 本轮作废、绝不写入），再按分支执行；send 先保存再经 sendOnce 记 notified；
 * reschedule 的 toolCall 由 handleWakeOutcome 校验后、调用方调
 * applyWakeToolCall 执行。deps 供测试注入 fake 模型/引擎/保存回调。
 */
async function runWakeRound(w, deps = {}) {
  const engine = deps.engine || (typeof wakeEngine !== 'undefined' ? wakeEngine : null);
  const parseDecision = deps.parseDecision || parseWakeDecision;
  if (!engine || !w) return { ok: false, reason: '唤醒引擎未就绪' };
  if (wakeRoundRunning) return { ok: false, reason: '已有唤醒回合在进行' };
  wakeRoundRunning = true;
  try {
    if (engine.isUserTyping?.()) {
      engine.cancelWake?.(w.wakeId, '用户正在发言，唤醒回合让位');
      return { ok: false, decision: 'cancelled', reason: '用户正在发言，唤醒回合已让位' };
    }
    // 领取已在 checkDueOnForeground 内完成（claimWake）；这里先记 accepted。
    await engine.markReceipt(w.wakeId, 'accepted', true);
    let raw;
    try {
      raw = deps.modelCall ? await deps.modelCall(w) : await callWakeModel(w);
    } catch (e) {
      // 模型调用失败：不发消息，只记 completed（本轮作废，不重试、不补发）。
      await engine.handleWakeOutcome(w.wakeId, { decision: 'skip' });
      return { ok: false, decision: 'skip', reason: e?.message || '唤醒模型调用失败' };
    }
    const parsed = parseDecision(raw);
    if (!parsed || parsed.decision === 'unknown') {
      await engine.handleWakeOutcome(w.wakeId, { decision: 'skip' });
      return { ok: true, decision: 'skip', reason: '模型决策无法解析，已跳过' };
    }
    // 统一用 handleWakeOutcome 收尾：用户中途发言时返回 cancelled，本轮作废。
    const outcome = await engine.handleWakeOutcome(w.wakeId, parsed);
    if (!outcome.ok) return outcome;
    if (parsed.decision === 'send') {
      const text = (parsed.message || '').trim();
      if (!text) {
        await engine.settleWake(w.wakeId, w.report, false);
        return { ok: true, decision: 'skip', reason: '模型决定发送但内容为空，已跳过' };
      }
      if (deps.saveReply) await deps.saveReply(text, w);
      else await saveWakeReply(text, w);
      await engine.sendOnce(w.wakeId, async () => ({ delivered: true }));
      await engine.settleWake(w.wakeId, w.report, true);
      return { ok: true, decision: 'send' };
    }
    if (parsed.decision === 'reschedule') {
      // handleWakeOutcome 的 reschedule 分支只返回校验后的 toolCall，不执行——
      // 调用方必须接着调 applyWakeToolCall。
      await engine.applyWakeToolCall(outcome.toolCall, w.charId);
      await engine.settleWake(w.wakeId, w.report, false);
      return { ok: true, decision: 'reschedule' };
    }
    await engine.settleWake(w.wakeId, w.report, false);
    return { ok: true, decision: 'skip' };
  } finally {
    wakeRoundRunning = false;
  }
}

/** 唤醒回合的模型调用：复用 buildCurrentRequest（近期聊天 + 相关记忆），
 * 末尾追加一条未落盘的唤醒指令（report 已含触发原因、有效情境、字条，
 * 不含位置/App/健康数据）。未配置主 API 时直接抛错，由调用方按 skip 处理。 */
async function callWakeModel(w) {
  if (!apiSettings.url || !apiSettings.key || !apiSettings.model) {
    throw new Error('未配置主 API，唤醒回合跳过');
  }
  const built = await buildCurrentRequest();
  const instruction = [
    '【主动唤醒】现在是计划好的主动联系时间，不是用户刚发消息的回复。',
    w.report?.text || w.trigger || '',
    '请你按角色判断：现在联系是否合适。回复格式：第一行只能写【发送】、【跳过】或【调整】其中之一。',
    '【发送】后面直接写要发给用户的一两句话（不要再写格式标记）；',
    '【跳过】表示这次不联系；',
    '【调整】后面写一个 JSON 工具调用（set_alarm / set_repeat / snooze / end_scene / update_scene / set_note / clear_note），用来改闹钟或情境。',
    '不要输出除此以外的解释。',
  ].join('\n');
  const body = { ...(built.req.body || {}) };
  if (Array.isArray(body.messages)) {
    body.messages = [...body.messages, { role: 'user', content: instruction }];
  } else if (Array.isArray(body.contents)) {
    body.contents = [...body.contents, { role: 'user', parts: [{ text: instruction }] }];
  } else {
    body.messages = [{ role: 'system', content: built.sys.systemPrompt || '' }, { role: 'user', content: instruction }];
  }
  const { text } = await sendChat(apiSettings, body, { signal: new AbortController().signal });
  return text || '';
}

/** 唤醒消息保存：复用正常助理消息链路（分段/心声/状态栏/落盘/渲染）。 */
async function saveWakeReply(text, w) {
  void w;
  await handleAiReplyContent(text, uid('round'), {});
}

async function boot() {
  // Safari's visual viewport shrinks with the keyboard; keep the composer inside it.
  const syncChatViewport = () => document.documentElement.style.setProperty(
    '--chat-viewport-height', `${window.visualViewport?.height || window.innerHeight}px`);
  syncChatViewport();
  window.visualViewport?.addEventListener('resize', syncChatViewport);
  window.addEventListener('resize', syncChatViewport);
  new ResizeObserver(([entry]) => $('#view-chat').style.setProperty('--composer-height', `${entry.target.offsetHeight}px`)).observe($('#composer'));
  try {
    await backend.init();
    await loadAll();
    LiquidGlass.init({ canvas: document.getElementById('gl-canvas'), onContextLost: () => toast('WebGL 已停用，已切换为 CSS 玻璃') });
    ThemeStore.init(backend, appearanceSettings);
    NavShell.init();
    // Register static and dynamically rendered surfaces with the supplied refraction engine.
    const selectors = '.glass, .post, .group, .card, .m-ico, .post-action';
    let glassSyncPending = false;
    const syncGlass = () => {
      glassSyncPending = false;
      document.querySelectorAll(selectors).forEach((node) => {
        // Chat uses its own material layer. Never paint shared glass snapshots behind quotes,
        // images or solid message bubbles; that caused the stray gray slabs in the old UI.
        if (node.closest('#view-chat')) { node.classList.remove('glass', 'gl-webgl'); LiquidGlass.detach(node); return; }
        node.classList.add('glass'); LiquidGlass.attach(node);
      });
      LiquidGlass.prune();
      LiquidGlass.refresh();
    };
    new MutationObserver(() => {
      if (!glassSyncPending) { glassSyncPending = true; requestAnimationFrame(syncGlass); }
    }).observe(document.getElementById('app'), { childList: true, subtree: true });
    syncGlass();
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    LiquidGlass.setAnim(!motionQuery.matches);
    motionQuery.addEventListener?.('change', (e) => LiquidGlass.setAnim(!e.matches));
    MomentsView.render(document.getElementById('moments-scroll'), { onCompose: () => toast('动态发布尚未接入，先看看就好') });
    ManageView.init({
      getState: () => ({ char, worldBooks, stickers, apiSettings, journals: char.memoryJournals, promptVersion: resolvePromptVersion(char, globalSettings) }),
      onRowClick: (id) => openSettings(id),
    });
    updateHeader();
    // 内嵌兜底：<head> 里的同名脚本是首选（首绘前挂 class）；这里再补一次，
    // 防止构建把 head 脚本 strip 掉。独立打开时 window.self === window.top，不挂。
    if (window.self !== window.top) document.documentElement.classList.add('embedded');
    // 聊天态同步：#view-chat 激活时给 #app 加 .in-chat，品牌行与 Tab 栏只在
    // 聊天页隐藏（.brand-bar 三页共用，只能隐藏不能删节点）。NavShell 在 nav.js 里，
    // 不在本轮文件集里，所以这里用 MutationObserver 跟它的切页走。
    const syncInChat = () => {
      const inChat = document.getElementById('view-chat').classList.contains('active');
      document.getElementById('app').classList.toggle('in-chat', inChat);
      // 离开聊天页时记下目的地，顶栏返回按钮用它回到主界面。
      if (!inChat) { const cur = NavShell.getCurrent(); if (cur && cur !== 'chat') lastHomeView = cur; }
    };
    new MutationObserver(syncInChat).observe(document.getElementById('view-chat'), { attributes: true, attributeFilter: ['class'] });
    syncInChat();
    // 生成状态恢复：上次生成中途刷新/切后台，绝不自动续生成，只提示已中断。
    // localStorage 标记（getReply 起止写）+ 残留 generating 消息双路检查。
    if (localStorage.getItem('uwu-chat.generating') === '1') {
      localStorage.removeItem('uwu-chat.generating');
      setTimeout(() => toast('上次生成已中断，未自动续生成'), 600);
    }
    try {
      const allMsgs = await backend.getAllMessages(char.id);
      const rec = recoverInterruptedMessages(allMsgs);
      if (rec.wasGenerating) {
        for (const m of rec.messages) {
          if (m.sendState === 'interrupted') await backend.put('messages', m);
        }
        setTimeout(() => toast('上次生成已中断，未自动续生成'), 600);
      }
    } catch (e) { console.warn('生成状态恢复检查失败（聊天不受影响）：', e); }
    // 草稿恢复（按角色）：输入框空着才回填，不覆盖已有输入。
    draftSaver = createDraftSaver(localStorage, char.id);
    const savedDraft = loadDraft(localStorage, char.id);
    if (savedDraft && !inputEl.value) {
      inputEl.value = savedDraft;
      autoGrow();
      $('#composer').classList.add('has-text');
    }
    // 启动时一次性恢复阅读位置（renderMessages 里认领一次即清）。
    restoreReadPosOnce = true;
    await renderMessages(false);
    // B 组初始化（模块均回调注入，不 import app.js）。
    inAppNotifier = new InAppNotifier({
      settings: notifySettings,
      env: {
        supportsVibration: 'vibrate' in navigator,
        supportsSound: true,
        playSound: () => { /* 可选：播一声短提示音；无音频文件时留空（降级说明已在模块内） */ },
        vibrate: (p) => navigator.vibrate?.(p),
      },
      onBanner: (banner) => renderInAppBanner(banner),
      onOpenChat: (charId, messageId) => openChatForBanner(charId, messageId),
    });
    await loadUnread(backend, inAppNotifier);
    audioKeepAlive = getAudioKeepAlive({
      onStateChange: () => { /* 状态变化时如需刷新设置页，调 renderSettingsBody() */ },
    });
    wakeEngine = new WakeEngine({
      store: backend,
      settings: wakeSettings,
      slmClient: null, // 总结副 API 接好后再传 auxApi.callSummaryChat 包装的分类回调；未传时只走关键词快路径
    });
    await wakeEngine.loadSettings();
    // Service Worker：只在用户开启推送时注册；注册失败不阻断启动。
    if (pushSettings.enabled && 'serviceWorker' in navigator) {
      const sw = await registerServiceWorker(navigator, '/sw.js');
      if (!sw.ok) console.warn('SW 注册失败：', sw.reason);
    }
    // 前台巡检：页面可见时按 patrolIntervalMin 检查唤醒到期；恢复前台立即检查一次。
    const wakePatrol = async () => {
      if (document.hidden || !wakeEngine || wakeRoundRunning || isGenerating) return;
      const { due } = await wakeEngine.checkDueOnForeground();
      for (const w of due) await runWakeRound(w); // 见下文 runWakeRound
    };
    setInterval(wakePatrol, Math.max(1, wakeSettings.patrolIntervalMin || 15) * 60 * 1000);
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) { audioKeepAlive?.handleVisibility(true); return; }
      audioKeepAlive?.handleVisibility(false); // 回前台不自动恢复保活（模块内已保证）
      await wakePatrol();
    });
    // 保存失败提示
    const origPut = backend.put.bind(backend);
    backend.put = async (...args) => {
      try {
        const saved = await origPut(...args);
        // B 组：消息先持久化再通知（notifyAfterPersist 的同一原则）。
        // 只对其他角色/非当前聊天页的消息弹横幅；当前正在看的聊天不重复遮挡。
        if (args[0] === 'messages' && args[1]?.role === 'assistant' && inAppNotifier) {
          inAppNotifier.notifyInApp({
            charId: args[1].charId,
            avatar: await charAvatarFor(args[1].charId),
            name: charNameFor(args[1].charId),
            summary: plainTextOf(args[1]),
            messageId: args[1].id,
          }, isChatPageVisible() ? char.id : null);
          await saveUnread(backend, inAppNotifier);
        }
        return saved;
      }
      catch (e) {
        setSaveState('保存失败');
        showModal('保存失败', `<p>${escapeHtml(e.message || '写入失败')}</p><p class="muted">你的消息还在当前页面，请立即导出备份。</p>`, [
          { label: '立即导出', primary: true, onClick: () => doExport(false) },
          { label: '关闭' },
        ]);
        throw e;
      }
    };
    setSaveState('已就绪');
  } catch (e) {
    console.warn(e);
    showModal('启动失败', `<p>${escapeHtml(e.message || '数据库初始化失败')}</p><p class="muted">请检查浏览器存储权限，或换一个浏览器再试。</p>`, [{ label: '刷新', primary: true, onClick: () => location.reload() }]);
  }
}
document.addEventListener('DOMContentLoaded', boot);

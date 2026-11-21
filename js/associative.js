// associative.js — 可关闭的联想召回（第 3 波，Callback_DLC 思路）。
// 本阶段只做当轮联想，不做轮间预备（prepare_after / 短名单缓存留给后续增强）。
//
// 三段式：
//  1. 线索生成：每件重要经历可生成 0–4 条线索（四种固定：当时处境 / 特殊原话 /
//     未来可能怎样问 / 未完成事项；0 条合法）。由总结副 API 在经历写入/更新时
//     生成（不用主聊天 API）；每条线索必须连回原文，存进经历记录的 clues 字段，
//     evidenceVersion = 生成时经历的 version；经历被编辑导致 version 变化后，
//     evidenceVersion 过期的线索视为失效（下次生成时更新或丢弃）。
//  2. 当轮联想检索：按线索文本（关键词 + 向量，与 fusedRetrieve 同款 RRF 思路）
//     从当前对话找候选（默认 6 件），与准确检索结果（fusedRetrieve 的 results）
//     按 docId 去重；失效 / 无出处 / 不参与检索的文档不得入选。
//  3. 副模型选择：调总结副 API 从候选中严格选“一个或空”，JSON 契约
//     {mode:'pick'|'none', pick: docId|null, use:'mention'|'understand', reason}，
//     不许强行挑选；解析失败 / 格式不对按“选空”处理。
//
// 超时与预算：联想选择单次超时 ≤8 秒（AbortController + Promise.race 双保险，
// 超时按选空）；调用预算按月计数的本地预算记录（settings 'assocBudget'，
// {month:'YYYY-MM', used, limit}，默认 limit 300 次/月）；超预算跳过联想、
// 不阻断聊天、不弹窗，只在记忆页显示预算状态。
//
// 冷却 6 轮：已提及（mentioned=true）的事件，在最近 6 个完整 AI 回复内降低
// 主动推荐优先级（联想候选里直接排除）；明确追问不受限制（该经历同时出现
// 在当轮 fusedRetrieve 的 results 里，或关键词路命中前 3 时绕过冷却）。
// 回执三态：已检索（进过选择）/ 已注入（选中并进请求）/ 回复实际提及
// （回复落盘后核对）。本波把数据结构与回执写好，预览展示由第 4 波重组时接上。
//
// 纯逻辑 + IndexedDB/设置读写，可被 Node 测试 import；不碰 DOM、不改提示词
// 区块结构（联想经历进请求的重组是第 4 波的事）。
import { callSummaryChat } from './auxApi.js';
import {
  CLUE_KINDS, normalizeClue, isExperienceValid, updateExperienceMeta,
} from './experiences.js';
import { tokenize, searchKeyword } from './keywordSearch.js';
import { cosineSimilarity, rrfFuse } from './vectorMemory.js';

export const CLUE_KIND_LABELS = {
  context: '当时处境', quote: '特殊原话', future: '未来可能怎样问', unfinished: '未完成事项',
};

/** 联想总开关（settings 'assocSettings'）：默认开；未配置副 API 时静默不启用。 */
export const DEFAULT_ASSOC_SETTINGS = { enabled: true };
/** 联想调用预算默认上限：300 次/月（settings 'assocBudget' 里可调）。 */
export const DEFAULT_ASSOC_BUDGET_LIMIT = 300;
/** 联想选择单次超时（毫秒）：≤8 秒，超时按选空处理。 */
export const ASSOC_PICK_TIMEOUT_MS = 8000;
/** 回执改述核验超时（毫秒）：比选择更短，超时只用标记匹配的结果。 */
export const ASSOC_VERIFY_TIMEOUT_MS = 5000;
/** 联想候选默认件数。 */
export const ASSOC_CANDIDATE_TOP_N = 6;
/** 冷却轮数：已提及的事件在最近这么多个完整 AI 回复内不主动推荐。 */
export const ASSOC_COOLDOWN_ROUNDS = 6;
/** 回执记录保留条数（settings 'assocReceipts'）。 */
export const ASSOC_RECEIPTS_LIMIT = 100;

const ASSOC_BUDGET_KEY = 'assocBudget';
const ASSOC_ROUND_SEQ_KEY = 'assocRoundSeq';
const ASSOC_RECEIPTS_KEY = 'assocReceipts';

/** 副 API 是否已配置（未配置时联想静默不启用，不弹窗）。 */
export function isSummaryApiConfigured(summaryApi) {
  return !!(summaryApi?.url && summaryApi?.key && summaryApi?.model);
}

/** 这件经历当前有效的线索：evidenceVersion 必须等于经历现在的 version。 */
export function validClues(exp) {
  const version = exp?.version;
  return (exp?.clues || []).filter((c) => c && c.evidenceVersion === version);
}

/** 线索文本（检索用）：标题 + 每条线索的 text 与 excerpt。 */
export function clueTextFor(exp) {
  const parts = [exp?.title || ''];
  for (const c of validClues(exp)) parts.push(`${c.text} ${c.excerpt}`);
  return parts.filter(Boolean).join('\n');
}

/* ---------------- 线索生成 ---------------- */

export const DEFAULT_CLUE_PROMPT = `只根据下面提供的经历内容生成联想线索；不要编造，不要把猜测写成事实。
线索是以后聊天时可能自然联想起这件经历的“钩子”，固定四种，每种最多一条，一件经历最多 4 条，0 条也合法（没把握就别写）：
- context（当时处境）：这件事发生时的处境、背景或氛围；
- quote（特殊原话）：经历里最特别、最可能被原样提起的一句原话；
- future（未来可能怎样问）：以后对方可能怎样问起、提起这件事；
- unfinished（未完成事项）：这件事里还没做完、还没兑现的部分（没有就别写）。
每条线索必须连回原文：excerpt 必须是经历内容（关键细节或关键原话）里的原文片段，照抄，不要改写；sourceMessageIds 必须是该片段来源消息的 ID（照抄记录里的 ID，不要自己编号）。
只返回一个 JSON 数组，不要加任何解释文字。数组每项格式：
{"text":"线索内容","kind":"context","excerpt":"原文片段","sourceMessageIds":["消息ID"]}`;

/** 组装一次线索生成调用的 messages：系统提示词（生成规则）+ 经历内容。 */
export function buildClueGenerationRequest(exp) {
  const quotes = (exp?.quotes || [])
    .map((q) => `[消息ID ${q.messageId}] ${q.speaker ? `${q.speaker}：` : ''}${q.text}`)
    .join('\n');
  const body = [
    `标题：${exp?.title || '未命名经历'}`,
    exp?.summary ? `关键细节：${exp.summary}` : '',
    quotes ? `关键原话：\n${quotes}` : '',
    exp?.timestamp ? `日期：${new Date(exp.timestamp).toISOString().slice(0, 10)}` : '',
  ].filter(Boolean).join('\n');
  return {
    messages: [
      { role: 'system', content: DEFAULT_CLUE_PROMPT },
      { role: 'user', content: `下面是需要生成联想线索的经历（每条原话行首 [消息ID …] 是该条消息的唯一编号，线索的 excerpt 必须照抄这里的原文，sourceMessageIds 必须照抄这里的 ID）：\n\n${body}` },
    ],
  };
}

function normForMatch(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * 一条线索是否连回原文：excerpt 必须是经历关键细节或某句关键原话里的
 * 原文片段（空白归一化后子串匹配），且 sourceMessageIds 必须全在经历的
 * 来源消息集合里。任一不满足即无效（丢弃，不写库）。
 */
export function validateClueAgainstExperience(clue, exp) {
  const c = normalizeClue(clue);
  if (!c) return false;
  const excerpt = normForMatch(c.excerpt);
  if (!excerpt) return false;
  const haystacks = [
    normForMatch(exp?.summary),
    ...(exp?.quotes || []).map((q) => normForMatch(q?.text)),
  ].filter(Boolean);
  if (!haystacks.some((h) => h.includes(excerpt))) return false;
  const sources = new Set([
    ...(exp?.sourceMessageIds || []),
    ...(exp?.quotes || []).map((q) => q?.messageId).filter(Boolean),
  ].map((id) => String(id)));
  if (!c.sourceMessageIds.every((id) => sources.has(id))) return false;
  return true;
}

/**
 * 解析副模型返回的线索 JSON。容错：去 ```json 围栏、取首尾方括号；
 * 不是 JSON 数组时抛错（不写库）；单条线索形状不对 / 连不回原文则丢弃该条、
 * 记一条原因；最多保留 4 条。
 * 返回 { clues（可写入的规范化线索，evidenceVersion = 经历当前 version）,
 *   dropped: [{reason}] }。
 */
export function parseClueGenerationResponse(text, exp) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('副模型返回的内容不是有效的 JSON 数组，无法生成线索，请重试。');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('副模型返回的内容不是有效的 JSON 数组，无法生成线索，请重试。');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('副模型返回的内容不是有效的 JSON 数组，无法生成线索，请重试。');
  }
  const clues = [];
  const dropped = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      dropped.push({ reason: '有一条线索不是有效的对象，已跳过。' });
      continue;
    }
    if (!CLUE_KINDS.includes(entry.kind)) {
      dropped.push({ reason: '有一条线索的种类不在四种固定种类里，已跳过。' });
      continue;
    }
    const withVersion = { ...entry, evidenceVersion: exp?.version ?? 1 };
    if (!validateClueAgainstExperience(withVersion, exp)) {
      dropped.push({ reason: '有一条线索的原文片段或来源消息对不上经历原文，已跳过。' });
      continue;
    }
    clues.push(normalizeClue(withVersion));
    if (clues.length >= 4) break;
  }
  return { clues, dropped };
}

/**
 * 为一件经历生成线索（经历写入/更新成功后触发；生成失败不阻断保存，
 * 由调用方静默跳过）。未配置副 API 时不调用、返回 {clues: [], skipped: 'no-api'}。
 * 成功时把线索写进经历记录的 clues 字段（updateExperienceMeta，不 bump version，
 * 否则 evidenceVersion 会刚写就过期）；失败时抛错（不写库）。
 * options：{summaryApi, callSummaryChat（可注入 fake，默认调真实总结副 API）}。
 */
export async function generateCluesForExperience(backend, exp, {
  summaryApi, callSummaryChat: callChat = callSummaryChat,
} = {}) {
  if (!exp?.id) throw new Error('生成线索需要经历记录。');
  if (!isSummaryApiConfigured(summaryApi)) {
    return { clues: [], dropped: [], skipped: 'no-api' };
  }
  const req = buildClueGenerationRequest(exp);
  const text = (await callChat(summaryApi, req.messages)).trim();
  if (!text) throw new Error('副 API 没有返回文字，请重试。');
  const { clues, dropped } = parseClueGenerationResponse(text, exp);
  await updateExperienceMeta(backend, exp.id, { clues });
  return { clues, dropped, updated: true };
}

/* ---------------- 预算（settings 'assocBudget'） ---------------- */

/** 本地月份键 'YYYY-MM'（按本地时间；跨月自动归零）。 */
export function monthKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 读预算记录：无记录时默认 {month: 本月, used: 0, limit: 300}；跨月自动归零（不写库）。 */
export async function loadAssocBudget(backend, now = new Date()) {
  const cur = monthKey(now);
  const row = await backend.get('settings', ASSOC_BUDGET_KEY);
  const saved = row?.value;
  if (!saved || typeof saved !== 'object') {
    return { month: cur, used: 0, limit: DEFAULT_ASSOC_BUDGET_LIMIT };
  }
  if (saved.month !== cur) {
    return { month: cur, used: 0, limit: Number.isFinite(saved.limit) ? saved.limit : DEFAULT_ASSOC_BUDGET_LIMIT };
  }
  return {
    month: cur,
    used: Number.isFinite(saved.used) ? Math.max(0, Math.floor(saved.used)) : 0,
    limit: Number.isFinite(saved.limit) ? Math.max(0, Math.floor(saved.limit)) : DEFAULT_ASSOC_BUDGET_LIMIT,
  };
}

export async function saveAssocBudget(backend, budget) {
  await backend.put('settings', { key: ASSOC_BUDGET_KEY, value: { ...budget } });
  return budget;
}

/** 预算检查（只读）：{allowed, used, limit, budgetLeft, month}。 */
export async function checkAssocBudget(backend, now = new Date()) {
  const b = await loadAssocBudget(backend, now);
  return { allowed: b.used < b.limit, used: b.used, limit: b.limit, budgetLeft: Math.max(0, b.limit - b.used), month: b.month };
}

/**
 * 消费一次预算：超限返回 null（调用方跳过联想）；否则 used+1 并写库，
 * 返回 {used, limit, budgetLeft}。跨月时先归零再计。
 */
export async function consumeAssocBudget(backend, now = new Date()) {
  const b = await loadAssocBudget(backend, now);
  if (b.used >= b.limit) return null;
  const next = { ...b, used: b.used + 1 };
  await saveAssocBudget(backend, next);
  return { used: next.used, limit: next.limit, budgetLeft: next.limit - next.used };
}

/* ---------------- 已完成 AI 回合序号（settings 'assocRoundSeq'） ---------------- */

/** 每角色的已完成 AI 回合序号：一轮 = 一次完整 AI 回复（多气泡同一 roundId 只算一轮）。 */
export async function getCompletedRoundSeq(backend, charId) {
  if (!charId) return 0;
  const row = await backend.get('settings', ASSOC_ROUND_SEQ_KEY);
  const seq = row?.value?.[charId];
  return Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : 0;
}

/** 每完成一次 AI 回复 +1，返回新序号。 */
export async function bumpCompletedRoundSeq(backend, charId) {
  if (!charId) return 0;
  const row = await backend.get('settings', ASSOC_ROUND_SEQ_KEY);
  const map = { ...(row?.value || {}) };
  const next = (Number.isFinite(map[charId]) ? Math.floor(map[charId]) : 0) + 1;
  map[charId] = next;
  await backend.put('settings', { key: ASSOC_ROUND_SEQ_KEY, value: map });
  return next;
}

/** 这件经历是否在冷却期内：最近 6 个完整 AI 回复内被提及过。 */
export function isCooledDown(exp, currentSeq) {
  const last = exp?.lastMentionedRoundSeq;
  if (!Number.isFinite(last)) return false;
  return currentSeq - last <= ASSOC_COOLDOWN_ROUNDS;
}

/**
 * 是否明确追问（绕过冷却）：该经历同时出现在当轮 fusedRetrieve 的 results 里，
 * 或关键词路命中前 3。keywordTopIds 是当轮关键词检索前 3 的 docId 集合
 * （fusedRetrieve 的 topN 可能把它截掉，单靠 results 看不见）。
 */
export function isExplicitFollowup(exp, fusedResults = [], keywordTopIds = []) {
  if (!exp?.id) return false;
  if ((keywordTopIds || []).includes(exp.id)) return true;
  return (fusedResults || []).some((r) => (r?.docId || r?.journalId) === exp.id);
}

/* ---------------- 当轮联想候选 ---------------- */

/** 经历是否有原文出处：来源消息非空（无出处的不进联想）。 */
function experienceSourced(exp) {
  const ids = exp?.sourceMessageIds?.length
    ? exp.sourceMessageIds
    : (exp?.quotes || []).map((q) => q?.messageId).filter(Boolean);
  return ids.length > 0;
}

/**
 * 当轮联想候选：按线索文本（关键词 + 向量，与 fusedRetrieve 同款 RRF 思路）
 * 从当前对话找，取少量候选（默认 6 件），与准确检索结果按 docId 去重。
 * 失效 / 无出处 / 不参与检索 / 无有效线索的经历不得入选；冷却期内的经历
 * 直接排除（明确追问除外）。
 *
 * opts：{backend, charId, experiences, queryText, queryEmbedding, spaceKey,
 *   fusedResults, currentSeq, embedTexts（可选，(texts)=>{vectors}），
 *   topN=6, keywordTopN=10, vectorTopN=10, threshold=0.40}
 * 返回候选数组，每条 {docId, docKind:'experience', title, date, timestamp,
 *   clues（有效线索）, quotes（前 2 条关键原话）, keywordRank, vectorRank, score}。
 */
export async function findAssocCandidates({
  backend, charId, experiences, queryText, queryEmbedding, spaceKey,
  fusedResults = [], currentSeq = 0, embedTexts = null,
  topN = ASSOC_CANDIDATE_TOP_N, keywordTopN = 10, vectorTopN = 10, threshold = 0.40,
} = {}) {
  const query = String(queryText || '').trim();
  if (!query) return [];
  // 明确追问判定用的关键词前 3（当轮查询文本对关键词索引跑一次）。
  let keywordTopIds = [];
  try {
    const top3 = await searchKeyword(backend, charId, query, { topN: 3 });
    keywordTopIds = top3.map((r) => r.docId);
  } catch { keywordTopIds = []; }
  const eligible = (experiences || []).filter((exp) => {
    if (!exp?.id || !isExperienceValid(exp)) return false;
    if (exp.retrievalEnabled === false) return false;
    if (!experienceSourced(exp)) return false;
    if (!validClues(exp).length) return false;
    if (isCooledDown(exp, currentSeq) && !isExplicitFollowup(exp, fusedResults, keywordTopIds)) return false;
    return true;
  });
  if (!eligible.length) return [];

  // 关键词路：查询词与线索文本（标题 + 线索 text/excerpt）的共有词数。
  const queryTerms = [...new Set(tokenize(query))];
  const keywordRanked = [];
  if (queryTerms.length) {
    const scored = eligible.map((exp) => {
      const terms = new Set(tokenize(clueTextFor(exp)));
      let shared = 0;
      for (const t of queryTerms) if (terms.has(t)) shared++;
      return { docId: exp.id, score: shared };
    }).filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || (a.docId < b.docId ? -1 : 1))
      .slice(0, Math.max(1, keywordTopN));
    scored.forEach((s, i) => keywordRanked.push({ docId: s.docId, rank: i + 1 }));
  }

  // 向量路：线索文本批量取向量，与查询向量比余弦（阈值只作用于这一路）。
  // 失败时只走关键词路（与 fusedRetrieve 的两路独立一致），不抛错。
  let vectorRanked = [];
  if (Array.isArray(queryEmbedding) && queryEmbedding.length > 0 && spaceKey && typeof embedTexts === 'function') {
    try {
      const texts = eligible.map((exp) => clueTextFor(exp));
      const { vectors } = await embedTexts(texts);
      const scored = [];
      (vectors || []).forEach((v, i) => {
        if (!v) return;
        const score = cosineSimilarity(queryEmbedding, v);
        if (score >= threshold) scored.push({ docId: eligible[i].id, score });
      });
      scored.sort((a, b) => b.score - a.score || (a.docId < b.docId ? -1 : 1))
        .slice(0, Math.max(1, vectorTopN))
        .forEach((s, i) => vectorRanked.push({ docId: s.docId, rank: i + 1 }));
    } catch { /* 向量路失败：只走关键词路 */ }
  }

  const fused = rrfFuse(keywordRanked, vectorRanked);
  const fusedIds = new Set((fusedResults || []).map((r) => r?.docId || r?.journalId).filter(Boolean));
  const byId = new Map(eligible.map((e) => [e.id, e]));
  const out = [...fused.values()]
    .sort((a, b) => b.score - a.score || (a.docId < b.docId ? -1 : 1))
    .filter((f) => !fusedIds.has(f.docId)) // 与准确检索结果按 docId 去重
    .slice(0, Math.max(1, topN))
    .map((f) => {
      const exp = byId.get(f.docId);
      if (!exp) return null;
      return {
        docId: exp.id,
        docKind: 'experience',
        title: exp.title || '',
        date: exp.timestamp ? new Date(exp.timestamp).toISOString().slice(0, 10) : '',
        timestamp: exp.timestamp || 0,
        clues: validClues(exp),
        quotes: (exp.quotes || []).slice(0, 2).map((q) => ({ text: q.text, speaker: q.speaker || '' })),
        keywordRank: f.keywordRank,
        vectorRank: f.vectorRank,
        score: f.score,
      };
    })
    .filter(Boolean);
  return out;
}

/* ---------------- 副模型选择 ---------------- */

/** 给副模型看的候选卡片：只含标题 / 线索 / 关键原话 / 日期，不含向量分数。 */
function candidateCard(c, i) {
  const lines = [
    `【候选${i + 1}】${c.title || '未命名经历'}（id: ${c.docId}）`,
    c.date ? `日期：${c.date}` : '',
    ...(c.quotes || []).map((q) => `关键原话：「${q.text}」${q.speaker ? ` —— ${q.speaker}` : ''}`),
    ...((c.clues || []).map((cl) => `线索（${CLUE_KIND_LABELS[cl.kind] || cl.kind}）：${cl.text}`)),
  ].filter(Boolean);
  return lines.join('\n');
}

export const DEFAULT_ASSOC_PICK_PROMPT = `你是聊天助手的联想判断员。当前对话在下面给出，候选是一件件过去的经历（每件带标题、日期、关键原话与联想线索）。
你的任务：判断当前对话是否自然地让人联想起其中某件经历——像是聊天中会顺口提起的那种联想，不是硬凑的关联。
规则：
- 最多选一件；没有哪件是自然联想，就选空，绝不强行挑选；
- 选中的那件应该是当前对话里确实在聊、或刚被提起的相关事，而不是“有点像”而已；
- use 表示怎么用这件经历：'mention'（回复里可以顺口提到它）或 'understand'（只用来理解背景，回复里不必提）；
- 只返回一个 JSON 对象，不要加任何解释文字。格式：
{"mode":"pick","pick":"候选的 id","use":"mention","reason":"一句话原因"}
选空时返回：{"mode":"none","pick":null,"use":"understand","reason":"一句话原因"}`;

/** 组装一次联想选择调用的 messages：系统提示词（选择规则）+ 当前对话 + 候选卡片。 */
export function buildAssocPickRequest({ candidates, queryText }) {
  const cards = (candidates || []).map((c, i) => candidateCard(c, i)).join('\n\n');
  return {
    messages: [
      { role: 'system', content: DEFAULT_ASSOC_PICK_PROMPT },
      {
        role: 'user',
        content: `当前对话（最新发言与最近对话拼成）：\n${queryText || ''}\n\n候选经历：\n${cards}`,
      },
    ],
  };
}

/** 选空结果（mode none / pick null / 解析失败 / 超时 / 预算耗尽都归到这里）。 */
export function emptyPick(status = 'none', reason = '') {
  return { mode: 'none', pick: null, use: 'understand', reason: String(reason || ''), status };
}

/**
 * 解析副模型返回的选择 JSON。容错：去 ```json 围栏、取首尾花括号；
 * mode 不是 pick/none、pick 不在候选里、pick 为空都按选空处理（不抛错）。
 * 返回 {mode, pick, use, reason, status}，status 为 'picked' | 'none'。
 */
export function parseAssocPickResponse(text, candidateIds = []) {
  const ids = new Set(candidateIds || []);
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return emptyPick('none', '副模型返回的内容不是有效的 JSON，已按选空处理。');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return emptyPick('none', '副模型返回的内容不是有效的 JSON，已按选空处理。');
  }
  if (!parsed || typeof parsed !== 'object') {
    return emptyPick('none', '副模型返回的格式不对，已按选空处理。');
  }
  const use = parsed.use === 'mention' ? 'mention' : 'understand';
  const reason = String(parsed.reason || '').slice(0, 200);
  if (parsed.mode === 'pick' && typeof parsed.pick === 'string' && ids.has(parsed.pick)) {
    return { mode: 'pick', pick: parsed.pick, use, reason, status: 'picked' };
  }
  return { mode: 'none', pick: null, use, reason: reason || '没有自然联想起的经历。', status: 'none' };
}

/**
 * 带超时的副 API 调用：AbortController（真 fetch 会被 abort）+ Promise.race
 * （副 API 封装不接受 signal 时也能保证 ≤timeoutMs 毫秒返回）。
 * 超时抛一个 name='TimeoutError' 的 Error。
 */
export async function callSummaryChatWithTimeout(callChat, summaryApi, messages, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const impl = fetchImpl || fetch;
  const fetchWithSignal = (url, opts) => impl(url, { ...(opts || {}), signal: controller.signal });
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const e = new Error('联想选择超时');
      e.name = 'TimeoutError';
      reject(e);
    }, timeoutMs);
  });
  try {
    return await Promise.race([callChat(summaryApi, messages, fetchWithSignal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 副模型选择：从候选中严格选“一个或空”。超时 / 解析失败 / 格式不对 /
 * 副模型报错都按选空处理，绝不抛错、不阻断聊天。
 * 返回 {mode, pick, use, reason, status}，status 为
 * 'picked' | 'none' | 'timeout' | 'error' | 'no-api' | 'no-candidates'。
 * options：{summaryApi, callSummaryChat（可注入 fake）, timeoutMs=8000, fetchImpl}。
 */
export async function pickAssocCandidate({
  summaryApi, callSummaryChat: callChat = callSummaryChat,
  candidates, queryText, timeoutMs = ASSOC_PICK_TIMEOUT_MS, fetchImpl,
} = {}) {
  if (!candidates?.length) return emptyPick('no-candidates', '本轮没有联想候选。');
  if (!isSummaryApiConfigured(summaryApi)) return emptyPick('no-api', '未配置总结副 API，联想未启用。');
  const ids = candidates.map((c) => c.docId);
  const req = buildAssocPickRequest({ candidates, queryText });
  try {
    const text = await callSummaryChatWithTimeout(callChat, summaryApi, req.messages, timeoutMs, fetchImpl);
    const trimmed = String(text || '').trim();
    if (!trimmed) return emptyPick('none', '副模型没有返回文字，已按选空处理。');
    return parseAssocPickResponse(trimmed, ids);
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return emptyPick('timeout', '联想选择超时，已按选空处理。');
    }
    return emptyPick('error', `联想选择失败，已按选空处理（${String(e?.message || e).slice(0, 80)}）。`);
  }
}

/** 联想选择空结果（存进 lastBuiltRequest.assoc 的形状）。 */
export function emptyAssoc(status = 'none', extra = {}) {
  return {
    pick: null, mode: 'none', use: 'understand', reason: '',
    candidates: [], budgetLeft: null, injectedAt: null, status,
    ...extra,
  };
}

/**
 * 当轮联想总入口（供 app.js 的 buildCurrentRequest 调用）：
 * 开关 / 副 API / 候选 / 预算 / 选择依次把关，任一步不满足都按选空返回，
 * 绝不抛错、不阻断聊天。
 *
 * opts：{backend, charId, queryText, queryEmbedding, spaceKey, fusedResults,
 *   experiences, summaryApi, embedTexts（可选）, callSummaryChat（可注入 fake）,
 *   assocEnabled=true, timeoutMs=8000, fetchImpl, now=Date.now()}
 * 返回 {pick（docId 或 null）, mode, use, reason,
 *   candidates:[{docId, docKind, title}], budgetLeft, injectedAt, status}。
 * status：'ok'（选中）/ 'none'（选空）/ 'disabled' / 'no-api' /
 *   'no-candidates' / 'budget-exceeded' / 'timeout' / 'error'。
 */
export async function runAssocForChat({
  backend, charId, queryText, queryEmbedding, spaceKey,
  fusedResults = [], experiences = [], summaryApi, embedTexts = null,
  callSummaryChat: callChat = callSummaryChat, assocEnabled = true,
  timeoutMs = ASSOC_PICK_TIMEOUT_MS, fetchImpl, now = Date.now(),
} = {}) {
  if (!assocEnabled) return emptyAssoc('disabled', { reason: '联想召回总开关已关闭。' });
  if (!isSummaryApiConfigured(summaryApi)) return emptyAssoc('no-api', { reason: '未配置总结副 API，联想未启用。' });
  const currentSeq = await getCompletedRoundSeq(backend, charId);
  const candidates = await findAssocCandidates({
    backend, charId, experiences, queryText, queryEmbedding, spaceKey,
    fusedResults, currentSeq, embedTexts,
  });
  const budget = await checkAssocBudget(backend);
  if (!candidates.length) {
    return emptyAssoc('no-candidates', { reason: '本轮没有联想候选。', budgetLeft: budget.budgetLeft });
  }
  if (!budget.allowed) {
    return emptyAssoc('budget-exceeded', {
      reason: `联想预算已用完（本月 ${budget.used}/${budget.limit} 次）。`,
      budgetLeft: 0,
    });
  }
  const consumed = await consumeAssocBudget(backend);
  if (!consumed) {
    return emptyAssoc('budget-exceeded', { reason: '联想预算已用完。', budgetLeft: 0 });
  }
  const picked = await pickAssocCandidate({
    summaryApi, callSummaryChat: callChat, candidates, queryText, timeoutMs, fetchImpl,
  });
  return {
    pick: picked.pick,
    mode: picked.mode,
    use: picked.use,
    reason: picked.reason,
    candidates: candidates.map((c) => ({ docId: c.docId, docKind: c.docKind, title: c.title })),
    budgetLeft: consumed.budgetLeft,
    injectedAt: picked.mode === 'pick' ? now : null,
    status: picked.status === 'picked' ? 'ok' : picked.status,
  };
}

/* ---------------- 回执结算（三态之“回复实际提及”） ---------------- */

/** 日期标记：YYYY-MM-DD / YYYY年M月D日 / M月D日 三种写法都算。 */
export function dateMarkers(timestamp) {
  if (!Number.isFinite(timestamp)) return [];
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return [];
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const p = (n) => String(n).padStart(2, '0');
  return [`${y}-${p(m)}-${p(day)}`, `${y}年${m}月${day}日`, `${m}月${day}日`];
}

/**
 * 原文标记匹配：关键原话（全文，超过 30 字时另加前 30 字前缀）/ 日期 /
 * 参与人名字（排除角色本人的名字，由调用方传 excludeNames）任一标记在
 * 回复文本里出现即算提及。返回 {mentioned, matched:[命中的标记文本]}。
 */
export function markerMentioned(replyText, exp, { excludeNames = [] } = {}) {
  const reply = normForMatch(replyText);
  if (!reply) return { mentioned: false, matched: [] };
  const markers = [];
  for (const q of exp?.quotes || []) {
    const t = normForMatch(q?.text);
    if (t.length < 4) continue;
    markers.push(t);
    if (t.length > 30) markers.push(t.slice(0, 30));
  }
  for (const d of dateMarkers(exp?.timestamp)) markers.push(d);
  const excluded = new Set((excludeNames || []).map((n) => String(n).trim()).filter(Boolean));
  for (const s of exp?.speakers || []) {
    const name = String(s || '').trim();
    if (name.length >= 2 && !excluded.has(name)) markers.push(name);
  }
  const matched = [...new Set(markers.filter((m) => m && reply.includes(m)))];
  return { mentioned: matched.length > 0, matched: matched.slice(0, 5) };
}

export const DEFAULT_ASSOC_VERIFY_PROMPT = `判断下面这段 AI 回复是否提到了给出的那件经历：原样提到、改述、化用都算提到；只是话题有点像、没有实际涉及那件事，不算。
只返回一个 JSON 对象，不要加任何解释文字。格式：{"mentioned":true,"reason":"一句话原因"} 或 {"mentioned":false,"reason":"一句话原因"}`;

/** 组装一次改述核验调用的 messages：经历（标题/关键细节/关键原话/日期）+ 回复文本。 */
export function buildAssocVerifyRequest({ exp, replyText }) {
  const quotes = (exp?.quotes || []).slice(0, 3).map((q) => `「${q.text}」`).join('\n');
  const body = [
    `标题：${exp?.title || '未命名经历'}`,
    exp?.summary ? `关键细节：${exp.summary}` : '',
    quotes ? `关键原话：\n${quotes}` : '',
    exp?.timestamp ? `日期：${new Date(exp.timestamp).toISOString().slice(0, 10)}` : '',
  ].filter(Boolean).join('\n');
  return {
    messages: [
      { role: 'system', content: DEFAULT_ASSOC_VERIFY_PROMPT },
      { role: 'user', content: `经历：\n${body}\n\nAI 回复：\n${replyText || ''}` },
    ],
  };
}

/** 解析改述核验的 JSON：返回 true/false，解析失败返回 null（用标记匹配的结果）。 */
export function parseAssocVerifyResponse(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return typeof parsed?.mentioned === 'boolean' ? parsed.mentioned : null;
  } catch {
    return null;
  }
}

/** 读回执记录（settings 'assocReceipts'，最新在前，只保留最近 100 条）。 */
export async function getAssocReceipts(backend) {
  const row = await backend.get('settings', ASSOC_RECEIPTS_KEY);
  const list = Array.isArray(row?.value) ? row.value : [];
  return list.filter((r) => r && typeof r === 'object');
}

/** 某件经历的最近一条回执（没有返回 null）。 */
export function latestReceiptForExp(receipts, experienceId) {
  return (receipts || []).find((r) => r?.experienceId === experienceId) || null;
}

/** 回执给记忆页看的中文状态文案。 */
export function receiptStatusText(receipt) {
  if (!receipt) return '未注入过';
  if (receipt.mentioned) {
    return receipt.method === 'model' ? '最近回执：已提及（副模型核验）' : '最近回执：已提及（原文标记）';
  }
  return '最近回执：已注入，未提及';
}

/**
 * 回执结算（AI 回复落盘后挂钩子调用，不要另起保存路径）：
 * 先做原文标记匹配（命中即 mentioned=true，method='marker'）；未命中时再用
 * 副模型改述核验（预算内、超时短；副模型不可用 / 超时 / 解析失败时只用
 * 标记匹配的结果，method 仍为 'marker'）。
 * 结果写入回执记录（settings 'assocReceipts'，只保留最近 100 条）与经历记录
 * 的 lastMentionedRoundSeq（仅 mentioned=true 时更新，序号取结算时的
 * 已完成 AI 回合序号）。没有 pick 时返回 null。
 * options：{backend, charId, roundId, replyText, assoc（lastBuiltRequest.assoc）,
 *   summaryApi, callSummaryChat（可注入 fake）, excludeNames（角色本人名字）,
 *   verifyTimeoutMs=5000, fetchImpl, now=Date.now()}。
 */
export async function settleAssocReceipt({
  backend, charId, roundId, replyText, assoc,
  summaryApi, callSummaryChat: callChat = callSummaryChat,
  excludeNames = [], verifyTimeoutMs = ASSOC_VERIFY_TIMEOUT_MS, fetchImpl, now = Date.now(),
} = {}) {
  if (!assoc?.pick) return null;
  const exp = await backend.get('experiences', assoc.pick);
  if (!exp) return null;
  const marker = markerMentioned(replyText, exp, { excludeNames });
  let mentioned = marker.mentioned;
  let method = 'marker';
  if (!mentioned && isSummaryApiConfigured(summaryApi)) {
    // 改述核验也要计预算：超预算 / 消费失败时只用标记匹配的结果。
    const consumed = await consumeAssocBudget(backend);
    if (consumed) {
      try {
        const req = buildAssocVerifyRequest({ exp, replyText });
        const text = await callSummaryChatWithTimeout(callChat, summaryApi, req.messages, verifyTimeoutMs, fetchImpl);
        const verdict = parseAssocVerifyResponse(text);
        if (verdict === true) { mentioned = true; method = 'model'; }
      } catch { /* 副模型不可用 / 超时：只用标记匹配的结果 */ }
    }
  }
  const currentSeq = await getCompletedRoundSeq(backend, charId);
  const receipt = {
    experienceId: exp.id,
    roundId: roundId || null,
    injectedAt: assoc.injectedAt ?? null,
    mentioned,
    checkedAt: now,
    method,
  };
  const receipts = await getAssocReceipts(backend);
  receipts.unshift(receipt);
  await backend.put('settings', {
    key: ASSOC_RECEIPTS_KEY, value: receipts.slice(0, ASSOC_RECEIPTS_LIMIT),
  });
  if (mentioned) {
    await updateExperienceMeta(backend, exp.id, { lastMentionedRoundSeq: currentSeq });
  }
  return receipt;
}

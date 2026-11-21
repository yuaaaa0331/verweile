// experiences.js — 经历记忆（experiences store，第 1 波）。
// 经历 = 从聊天原文里提取出的、可追溯到具体消息的一件事：标题 + 关键细节 +
// 关键原话（每条必须带来源消息 ID）+ 计划/结果状态。
// 规则（见 spec）：
//  - plan_state 与 outcome_state 是两个独立字段；outcome 只有拿到后续原文
//    （evidenceMessageIds 非空）才能填，日期过去不自动算完成；
//  - status='invalid' 表示来源被删/撤回后失效，失效的不进检索（第 2 波在检索层
//    过滤，本文件只提供 isExperienceValid / markExperienceInvalid）；
//  - 提取复用总结副 API，不新增服务；提取是用户主动触发，不开机自动跑；
//    批量队列/暂停/恢复/Worker 由第 4 波做，本波只提供单次范围提取。
// 纯逻辑 + IndexedDB 读写，可被 Node 测试 import；不碰 DOM。
import { uid } from './utils.js';
import { isExcludedFromSummary, extractSummarizableText, countRounds } from './memorySummary.js';
import { callSummaryChat } from './auxApi.js';

/** 计划状态：none 无计划含义 / planned 已约好 / completed 已完成 / cancelled 已取消 /
 *  hypothetical 假设剧情 / setting 角色设定 / paraphrase 转述。 */
export const PLAN_STATES = new Set(['none', 'planned', 'completed', 'cancelled', 'hypothetical', 'setting', 'paraphrase']);
export const PLAN_STATE_LABELS = {
  none: '', planned: '计划', completed: '已完成', cancelled: '已取消',
  hypothetical: '假设剧情', setting: '角色设定', paraphrase: '转述',
};
/** 结果状态：只有拿到后续原文佐证才能填。 */
export const OUTCOME_STATES = new Set(['completed', 'cancelled', 'rescheduled']);
export const OUTCOME_STATE_LABELS = { completed: '已完成', cancelled: '已取消', rescheduled: '已改期' };

/**
 * 联想线索种类（第 3 波，固定四种）：context 当时处境 / quote 特殊原话 /
 * future 未来可能怎样问 / unfinished 未完成事项。一件经历最多 4 条线索，
 * 0 条合法。线索存在经历记录的 clues 字段里，不另建 store。
 */
export const CLUE_KINDS = ['context', 'quote', 'future', 'unfinished'];

/**
 * 归一化一条线索（只做形状校验，不校验 excerpt 是否出自原文——那一步在
 * associative.js 里对照经历内容做）。非法形状返回 null。
 * 线索结构：{text, kind, excerpt（原文片段）, sourceMessageIds, evidenceVersion}，
 * evidenceVersion = 生成时经历的 version；经历被编辑导致 version 变化后，
 * evidenceVersion 过期的线索视为失效（由 associative.validClues 过滤）。
 */
export function normalizeClue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text || '').trim();
  const excerpt = String(raw.excerpt || '').trim();
  if (!text || !excerpt) return null;
  if (!CLUE_KINDS.includes(raw.kind)) return null;
  const sourceMessageIds = [...new Set(
    (Array.isArray(raw.sourceMessageIds) ? raw.sourceMessageIds : []).map((id) => String(id)).filter(Boolean),
  )];
  if (!sourceMessageIds.length) return null;
  if (!Number.isFinite(raw.evidenceVersion)) return null;
  return {
    text: text.slice(0, 200),
    kind: raw.kind,
    excerpt: excerpt.slice(0, 500),
    sourceMessageIds,
    evidenceVersion: Math.floor(raw.evidenceVersion),
  };
}

/** 归一化线索列表：非法条目丢弃，最多保留 4 条（多余的按原顺序截断）。 */
export function normalizeClues(clues) {
  const out = [];
  for (const c of Array.isArray(clues) ? clues : []) {
    const n = normalizeClue(c);
    if (n) out.push(n);
    if (out.length >= 4) break;
  }
  return out;
}

function normalizeQuotes(quotes) {
  const out = [];
  for (const q of Array.isArray(quotes) ? quotes : []) {
    const text = String(q?.text || '').trim();
    const messageId = String(q?.messageId || '').trim();
    if (!text || !messageId) continue; // 原话必须带来源消息 ID，否则丢弃
    out.push({
      text,
      messageId,
      speaker: String(q?.speaker || '').trim(),
      timestamp: Number.isFinite(q?.timestamp) ? q.timestamp : null,
    });
  }
  return out;
}

function normalizeOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return null;
  if (!OUTCOME_STATES.has(outcome.state)) return null;
  const evidence = [...new Set((outcome.evidenceMessageIds || []).map((id) => String(id)).filter(Boolean))];
  if (!evidence.length) return null; // 没有后续原文佐证，结果状态不成立
  return {
    state: outcome.state,
    evidenceMessageIds: evidence,
    at: Number.isFinite(outcome.at) ? outcome.at : Date.now(),
  };
}

/**
 * 建一条经历记录（不写库，只做结构归一化）。
 * 输入：{charId（必填）, title, summary, quotes, speakers, timestamp,
 *   plan_state, outcome_state, sourceMessageIds, range, source, retrievalEnabled}。
 */
export function createExperienceRecord(input = {}) {
  if (!input?.charId) throw new Error('创建经历记录需要 charId。');
  const now = Date.now();
  const quotes = normalizeQuotes(input.quotes);
  const sourceMessageIds = [...new Set(
    (Array.isArray(input.sourceMessageIds) ? input.sourceMessageIds : quotes.map((q) => q.messageId))
      .map((id) => String(id)).filter(Boolean),
  )];
  return {
    id: input.id || uid('exp'),
    charId: input.charId,
    title: String(input.title || '未命名经历').trim().slice(0, 200) || '未命名经历',
    summary: String(input.summary || '').trim(),
    quotes,
    speakers: [...new Set((input.speakers || []).map((s) => String(s).trim()).filter(Boolean))],
    timestamp: Number.isFinite(input.timestamp) ? input.timestamp : now,
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now,
    updatedAt: now,
    version: Number.isFinite(input.version) && input.version >= 1 ? Math.floor(input.version) : 1,
    status: input.status === 'invalid' ? 'invalid' : 'active',
    plan_state: PLAN_STATES.has(input.plan_state) ? input.plan_state : 'none',
    outcome_state: normalizeOutcome(input.outcome_state),
    sourceMessageIds,
    range: input.range && typeof input.range === 'object'
      ? {
          fromMessageId: input.range.fromMessageId || null,
          toMessageId: input.range.toMessageId || null,
          rounds: Number.isFinite(input.range.rounds) ? input.range.rounds : 0,
        }
      : null,
    source: String(input.source || '经历提取'),
    retrievalEnabled: input.retrievalEnabled !== false,
    // 联想线索（第 3 波）：0–4 条，每条连回原文；无线索时为空数组。
    clues: normalizeClues(input.clues),
    // 上一次回复实际提及这件经历时的已完成 AI 回合序号（第 3 波冷却用）；
    // 从未被提及过为 null。只由回执结算写，不由内容编辑改。
    lastMentionedRoundSeq: Number.isFinite(input.lastMentionedRoundSeq)
      ? Math.floor(input.lastMentionedRoundSeq) : null,
  };
}

/** 这条经历是否有效：status='invalid'（来源被删/撤回后失效）的不进检索。 */
export function isExperienceValid(exp) {
  return !!exp && exp.status !== 'invalid';
}

/** 把一条经历标为失效（来源被删/撤回后调用）；不存在返回 null。 */
export async function markExperienceInvalid(backend, id) {
  const old = await backend.get('experiences', id);
  if (!old) return null;
  if (old.status === 'invalid') return old;
  const next = { ...old, status: 'invalid', updatedAt: Date.now() };
  await backend.put('experiences', next);
  return next;
}

/**
 * 编辑经历：只改白名单字段，version+1。quotes 至少保留一句带来源的原话，
 * 否则抛错；来源消息集合随 quotes 一起更新。
 */
export async function updateExperience(backend, id, patch = {}) {
  const old = await backend.get('experiences', id);
  if (!old) return null;
  const allowed = {};
  if (typeof patch.title === 'string') allowed.title = patch.title.trim().slice(0, 200) || old.title;
  if (typeof patch.summary === 'string') allowed.summary = patch.summary.trim();
  if (Array.isArray(patch.quotes)) {
    const quotes = normalizeQuotes(patch.quotes);
    if (!quotes.length) throw new Error('经历至少需要一句带来源的原话，不能全删。');
    allowed.quotes = quotes;
    allowed.sourceMessageIds = [...new Set(quotes.map((q) => q.messageId))];
  }
  if (Array.isArray(patch.speakers)) {
    allowed.speakers = [...new Set(patch.speakers.map((s) => String(s).trim()).filter(Boolean))];
  }
  if (PLAN_STATES.has(patch.plan_state)) allowed.plan_state = patch.plan_state;
  if ('outcome_state' in patch) allowed.outcome_state = normalizeOutcome(patch.outcome_state);
  if (typeof patch.retrievalEnabled === 'boolean') allowed.retrievalEnabled = patch.retrievalEnabled;
  if (patch.status === 'active' || patch.status === 'invalid') allowed.status = patch.status;
  // 联想线索（第 3 波）：编辑经历时可整体替换线索；替换后 evidenceVersion
  // 按写入时的新 version 计——调用方（线索生成）应走 updateExperienceMeta，
  // 它不 bump version，evidenceVersion 才不会刚写就过期。
  if (Array.isArray(patch.clues)) allowed.clues = normalizeClues(patch.clues);
  if (Number.isFinite(patch.lastMentionedRoundSeq)) {
    allowed.lastMentionedRoundSeq = Math.floor(patch.lastMentionedRoundSeq);
  } else if (patch.lastMentionedRoundSeq === null) {
    allowed.lastMentionedRoundSeq = null;
  }
  const next = { ...old, ...allowed, version: (old.version || 1) + 1, updatedAt: Date.now() };
  await backend.put('experiences', next);
  return next;
}

/**
 * 只写经历的派生元数据（第 3 波系统写路径）：clues / lastMentionedRoundSeq。
 * 不 bump version——线索是经历内容的派生、回执是提及记录，都不是内容编辑；
 * bump 的话线索的 evidenceVersion 会刚写就过期、回执也会让线索失效。
 * patch 里其它字段一律忽略。
 */
export async function updateExperienceMeta(backend, id, patch = {}) {
  const old = await backend.get('experiences', id);
  if (!old) return null;
  const allowed = {};
  if (Array.isArray(patch.clues)) allowed.clues = normalizeClues(patch.clues);
  if (Number.isFinite(patch.lastMentionedRoundSeq)) {
    allowed.lastMentionedRoundSeq = Math.floor(patch.lastMentionedRoundSeq);
  } else if (patch.lastMentionedRoundSeq === null) {
    allowed.lastMentionedRoundSeq = null;
  }
  if (!Object.keys(allowed).length) return old;
  const next = { ...old, ...allowed, updatedAt: Date.now() };
  await backend.put('experiences', next);
  return next;
}

/** 物理删除一条经历（第 2 波接索引清理；本波先把记录删掉即可）。 */
export async function deleteExperience(backend, id) {
  await backend.delete('experiences', id);
}

/** 取某角色的全部经历，按事件时间倒序。失效的也返回，由调用方用 isExperienceValid 过滤。 */
export async function getExperiencesForChar(backend, charId) {
  const all = await backend.getAll('experiences');
  return all
    .filter((e) => e?.charId === charId)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

/**
 * 给 UI 的中文状态文案。plan_state 与 outcome_state 独立：有后续原文佐证的
 * outcome 时优先显示结果（已完成/已取消/已改期），否则显示计划状态。
 */
export function planOutcomeLabel(exp) {
  const outcome = exp?.outcome_state;
  if (outcome?.state && OUTCOME_STATE_LABELS[outcome.state]) {
    const n = (outcome.evidenceMessageIds || []).length;
    return n ? `${OUTCOME_STATE_LABELS[outcome.state]}（${n} 条后续原文佐证）` : OUTCOME_STATE_LABELS[outcome.state];
  }
  return PLAN_STATE_LABELS[exp?.plan_state] || '';
}

/**
 * 记忆（journal）有没有原文出处。唯一可操作的判定：isSummary 且
 * sourceMessageIds 非空且 range 存在 → 'sourced'，否则 'unsourced'。
 * source 字段只是自由文本，不能当作出处依据；代码里没有 hasSource 这类字段。
 * 记忆页列表与后续检索证据区共用它。
 */
export function sourceStatusOfJournal(j) {
  if (j?.isSummary === true
    && Array.isArray(j.sourceMessageIds) && j.sourceMessageIds.length > 0
    && j.range) return 'sourced';
  return 'unsourced';
}

/* ---------------- 提取（复用总结副 API） ---------------- */

/** 经历提取提示词：只写原文能支撑的内容，猜测必须标出来，绝不记成事实。 */
export const DEFAULT_EXPERIENCE_PROMPT = `只根据下面提供的聊天记录提取经历；不要编造，不要把猜测写成事实。
每件经历是一件具体发生过、或明确约好要做的事：标题一句话概括，关键细节写清人物、时间、地点与结果。
每件经历必须附关键原话 quotes：原文照抄，每条必须写明 messageId（照抄记录行首的 [消息ID …]，不要自己编号）与说话人（记录里的名字）；拿不准来源的原话宁可不要，不要硬凑。
只写原文能支撑的内容：模型自己的猜测、自行扩写、把“打算 / 如果 / 假设”当成已发生的事，必须标 plan_state 为 'hypothetical'（假设剧情）或 'paraphrase'（转述他人或别处的话），绝不能记成双方确实经历过的事实。
plan_state 取值：'none'（无计划含义）/ 'planned'（原文明确约好要做）/ 'completed'（原文明确已经完成）/ 'cancelled'（原文明确取消）/ 'hypothetical' / 'setting'（角色设定、世界观说明）/ 'paraphrase'。
不要填结果状态：事情后来是否完成，由以后的聊天原文佐证，不由模型推断。
不要总结 HTML/CSS 代码、状态栏模板代码、Base64 图片、系统提示词。
只返回一个 JSON 数组，不要加任何解释文字。数组每项格式：
{"title":"事件概括","summary":"关键细节","quotes":[{"text":"原话","messageId":"消息ID","speaker":"说话人"}],"speakers":["参与人名字"],"timestamp":事件时间的毫秒时间戳（拿不准就用原话所在消息的时间）,"plan_state":"none"}`;

/**
 * 把选定范围的消息转成给提取模型看的记录：复用总结的文本化（图片只留 [图片]
 * 标记、状态/思考/HTML 已排除），每行行首加 [消息ID …]，供模型引用原话时照抄。
 */
export function buildExperienceTranscript(messages, character) {
  const lines = [];
  for (const m of messages || []) {
    if (isExcludedFromSummary(m, character)) continue;
    const line = extractSummarizableText([m], character).trim();
    if (line) lines.push(`[消息ID ${m.id}] ${line}`);
  }
  return lines.join('\n');
}

/** 组装一次经历提取调用的 messages：系统提示词（提取规则）+ 带消息 ID 的聊天记录。 */
export function buildExperienceExtractionRequest({ transcript }) {
  return {
    messages: [
      { role: 'system', content: DEFAULT_EXPERIENCE_PROMPT },
      { role: 'user', content: `下面是需要提取经历的聊天记录（每行行首 [消息ID …] 是该条消息的唯一编号，引用原话时必须照抄）：\n\n${transcript || ''}` },
    ],
  };
}

function normalizeExtractedItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim();
  const summary = String(raw.summary || '').trim();
  if (!title || !summary) return null;
  const quotes = normalizeQuotes(raw.quotes);
  if (!quotes.length) return null; // 没有可用的原话引用：整件不收
  return {
    title: title.slice(0, 200),
    summary,
    quotes,
    speakers: [...new Set((Array.isArray(raw.speakers) ? raw.speakers : []).map((s) => String(s).trim()).filter(Boolean))],
    timestamp: Number.isFinite(raw.timestamp) ? raw.timestamp : null,
    plan_state: PLAN_STATES.has(raw.plan_state) ? raw.plan_state : 'none',
  };
}

/**
 * 解析副模型返回的经历 JSON。容错：去 ```json 围栏、取首尾方括号；
 * 不是 JSON 数组时抛错（不写库）；单件字段缺失则丢弃该件、记一条原因。
 * 返回 { items（可写入的规范化经历）, dropped: [{reason}] }。
 */
export function parseExperienceExtractionResponse(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('副模型返回的内容不是有效的 JSON 数组，无法提取经历，请重试。');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('副模型返回的内容不是有效的 JSON 数组，无法提取经历，请重试。');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('副模型返回的内容不是有效的 JSON 数组，无法提取经历，请重试。');
  }
  const items = [];
  const dropped = [];
  for (const entry of parsed) {
    const item = normalizeExtractedItem(entry);
    if (!item) {
      dropped.push({ reason: '有一件经历缺少标题、关键细节或可用的原话引用，已跳过。' });
      continue;
    }
    items.push(item);
  }
  return { items, dropped };
}

/**
 * 单次范围提取：选定范围的有效消息 → 总结副 API → 逐件写库。
 * 写前校验每条 quote 的 messageId 确实在当前有效消息集合里，否则丢弃该 quote；
 * 整件经历没有任何有效 quote 时不写入、记一条跳过原因。
 * 返回 { created（写库的经历记录数组）, skipped: [{reason}] }。
 * 不推进总结锚点、不开机自动跑；批量队列/暂停/恢复/Worker 由第 4 波做。
 * options：{ onProgress({phase, done, total}), summaryApi（总结副 API 配置）,
 *   callSummaryChat（可注入 fake，默认调真实总结副 API） }。
 */
export async function extractExperiencesFromRange(backend, char, messages, {
  onProgress, summaryApi, callSummaryChat: callChat = callSummaryChat,
} = {}) {
  const valid = (messages || []).filter((m) => !isExcludedFromSummary(m, char));
  if (!valid.length) {
    return { created: [], skipped: [{ reason: '选定范围里没有可提取的有效消息（状态、思考、撤回、HTML 模板类内容不进提取）。' }] };
  }
  const transcript = buildExperienceTranscript(valid, char);
  if (!transcript.trim()) {
    return { created: [], skipped: [{ reason: '选定范围里没有可提取的正文。' }] };
  }
  if (!summaryApi?.url || !summaryApi?.key || !summaryApi?.model) {
    throw new Error('未配置记忆总结副 API：请先在「我 → API 设置 → 记忆总结副 API」里填写 Base URL、API Key 和模型。提取不会使用主 API。');
  }
  onProgress?.({ phase: 'calling', done: 0, total: 0 });
  const req = buildExperienceExtractionRequest({ transcript });
  const text = (await callChat(summaryApi, req.messages)).trim();
  if (!text) throw new Error('副 API 没有返回文字，请重试。');
  onProgress?.({ phase: 'parsing', done: 0, total: 0 });
  const { items, dropped } = parseExperienceExtractionResponse(text);
  const skipped = [...dropped];
  const validById = new Map(valid.map((m) => [m.id, m]));
  const rounds = countRounds(valid, char);
  const range = { fromMessageId: valid[0].id, toMessageId: valid[valid.length - 1].id, rounds };
  const created = [];
  for (const item of items) {
    const quotes = [];
    let droppedQuotes = 0;
    for (const q of item.quotes) {
      const src = validById.get(q.messageId);
      if (!src) { droppedQuotes++; continue; } // 引用了范围外 / 已排除消息的原话：丢弃
      quotes.push({
        text: q.text,
        messageId: q.messageId,
        speaker: q.speaker || (src.role === 'user' ? (char?.myName || '我') : (char?.realName || '对方')),
        timestamp: Number.isFinite(q.timestamp) ? q.timestamp : (src.timestamp || null),
      });
    }
    if (!quotes.length) {
      skipped.push({ reason: `「${item.title}」的原话都无法对应到选定范围内的有效消息，已跳过。` });
      continue;
    }
    if (droppedQuotes > 0) {
      skipped.push({ reason: `「${item.title}」：${droppedQuotes} 句原话的来源不在选定范围内，已丢弃，只保留了其余 ${quotes.length} 句。` });
    }
    const ts = Number.isFinite(item.timestamp)
      ? item.timestamp
      : (quotes[quotes.length - 1].timestamp || Date.now());
    const rec = createExperienceRecord({
      charId: char.id,
      title: item.title,
      summary: item.summary,
      quotes,
      speakers: item.speakers,
      timestamp: ts,
      plan_state: item.plan_state,
      sourceMessageIds: [...new Set(quotes.map((q) => q.messageId))],
      range,
    });
    await backend.put('experiences', rec);
    created.push(rec);
    onProgress?.({ phase: 'saving', done: created.length, total: items.length });
  }
  return { created, skipped };
}

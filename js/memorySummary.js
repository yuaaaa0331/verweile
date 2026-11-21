// memorySummary.js — 记忆总结的纯逻辑（memorySummary）。
// 轮次计数、总结范围选择、总结内容过滤、总结提示词组装。
// 只读选定角色、指定范围的真实聊天；不写库、不调网络，可在 Node 测试里直接验证。
import { classifyContent } from './replyParser.js';
import { effectiveParts, messageText, extractProtocolText, serializeUserMessage } from './historyBuilder.js';
import { pad } from './utils.js';

/** 总结提示词默认值：写明只按提供的记录总结、不编造、不总结代码类内容。 */
export const DEFAULT_SUMMARY_PROMPT = `只根据下面提供的聊天记录做总结；不要编造，不要把猜测写成事实。
提取：重要经历、双方关系变化、明确约定、稳定喜好、重要人物、未完成事项。
保留人物、日期和事件背景。
不要总结 HTML/CSS 代码、状态栏模板代码、Base64 图片、系统提示词。
用简洁的中文分条写，每条一件事。`;

export const SUMMARY_LENGTHS = {
  short: { label: '短', instruction: '控制在 200 字以内，只写最重要的事。' },
  medium: { label: '中', instruction: '控制在 500 字以内。' },
  long: { label: '长', instruction: '控制在 1000 字以内，可以写得详细一些。' },
};

/** 总结要排除的段种类：状态、隐藏指令、撤回、HTML 卡片/模板代码。 */
const EXCLUDED_SEGMENT_KINDS = new Set([
  'status', 'transferResponse', 'giftResponse', 'withdraw', 'html',
]);

/**
 * 这条消息要不要排除在总结之外。
 * 复用 replyParser 的分类逻辑：状态更新、思考过程、隐藏指令（接收/退回转账、
 * 接收礼物）、撤回占位、HTML 卡片/模板代码都不进总结；只要有一段是正文就保留，
 * 提取时只取允许的段。
 */
export function isExcludedFromSummary(msg, character) {
  if (!msg) return true;
  if (msg.isStatusUpdate || msg.isThinking || msg.isContextDisabled) return true;
  if (msg.isWithdrawn) return true;
  const c = String(msg.content || '').trim();
  if (c.startsWith('<thinking>')) return true;
  const seg = classifyContent(msg.content || '', character || {}, {});
  const segs = seg.kind === 'mixed' ? seg.segments : [seg];
  if (!segs.length) return true;
  return segs.every((s) => EXCLUDED_SEGMENT_KINDS.has(s.kind));
}

/**
 * 轮次计数：一轮 = 一次用户发言 + 对应完整 AI 回复。
 * 按 roundId / 回复归属算，不按拆分气泡计数：同一 roundId 的多条气泡只算一轮，
 * 没有 roundId 的旧数据按连续的 AI 消息块算一轮；只有用户发言、还没有 AI 回复
 * 的不完整轮次不算；状态/思考等隐藏消息不算。
 */
export function countRounds(messages, character) {
  const list = (messages || []).filter((m) => !isExcludedFromSummary(m, character));
  let rounds = 0;
  let pendingUser = false;
  let inAssistantBlock = false;
  let currentRoundId = null;
  for (const m of list) {
    if (m.role === 'user') {
      pendingUser = true;
      inAssistantBlock = false;
      currentRoundId = null;
    } else if (m.role === 'assistant') {
      if (!pendingUser) continue;
      const rid = m.roundId || null;
      if (!inAssistantBlock) {
        rounds++;
        inAssistantBlock = true;
        currentRoundId = rid;
      } else if (rid && currentRoundId && rid !== currentRoundId) {
        // 同一 AI 消息块里出现新的 roundId（极少见）：算作另一轮回复
        rounds++;
        currentRoundId = rid;
      }
    }
  }
  return rounds;
}

/** 每一轮的起始下标（该轮第一条用户消息）。 */
function roundStarts(messages, character) {
  const starts = [];
  const list = messages || [];
  let pendingUser = false;
  let inAssistantBlock = false;
  let currentRoundId = null;
  let roundUserStart = -1;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (isExcludedFromSummary(m, character)) continue;
    if (m.role === 'user') {
      // 新一轮的用户发言：上一轮已由 AI 回复收尾（inAssistantBlock 为真时），
      // 或这是第一轮；记下本轮第一条用户消息的位置。
      if (!pendingUser || inAssistantBlock) roundUserStart = i;
      pendingUser = true;
      inAssistantBlock = false;
      currentRoundId = null;
    } else if (m.role === 'assistant') {
      if (!pendingUser) continue;
      const rid = m.roundId || null;
      if (!inAssistantBlock) {
        starts.push(roundUserStart);
        inAssistantBlock = true;
        currentRoundId = rid;
      } else if (rid && currentRoundId && rid !== currentRoundId) {
        starts.push(roundUserStart);
        currentRoundId = rid;
      }
    }
  }
  return starts;
}

/** 取最近 N 轮的消息（含该轮的全部用户消息与 AI 回复气泡）。 */
export function selectMessagesForRounds(messages, n, character) {
  const count = Math.max(1, Math.floor(n) || 1);
  const starts = roundStarts(messages, character);
  if (!starts.length) return [];
  const from = starts[Math.max(0, starts.length - count)];
  return (messages || []).slice(from);
}

/** 取上次总结锚点之后、尚未总结过的消息；锚点为空或找不到时返回全部。 */
export function unsummarizedMessages(messages, lastSummarizedMessageId) {
  const list = messages || [];
  if (!lastSummarizedMessageId) return list;
  const idx = list.findIndex((m) => m.id === lastSummarizedMessageId);
  if (idx === -1) return list;
  return list.slice(idx + 1);
}

/** 单个解析段转成可进总结的文本；排除的段返回 ''。 */
function segmentSummaryText(s) {
  switch (s.kind) {
    case 'text':
      return extractProtocolText(s.content);
    case 'bilingual':
      return `${s.foreign}（${s.chinese}）`;
    case 'quote':
      return `引用“${s.quoted}”并回复：${s.reply}`;
    case 'photo':
      return `[照片：${s.body || ''}]`;
    case 'voice':
      return `[语音：${s.body || ''}]`;
    case 'sticker':
    case 'stickerUnknown':
      return `[表情包：${s.name}]`;
    case 'transfer':
      return `[转账：${s.body || ''}]`;
    case 'gift':
      return `[礼物：${s.body || ''}]`;
    case 'forward':
      return '[转发的聊天记录]';
    default:
      return '';
  }
}

function cleanSummaryLine(t) {
  return String(t || '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (l.includes('data:image/')) return false; // Base64 图片绝不进总结
      if (/^<[^>]+>$/.test(l)) return false; // 整行就是一个 HTML 标签
      if (/^<\/?(style|script|div|span|html|body|head|template)\b/i.test(l)) return false;
      return true;
    })
    .join('\n');
}

function formatSummaryTime(ts) {
  const d = new Date(ts || 0);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 把选定范围的消息转成给总结模型看的纯文本记录。
 * 只取文本：图片只留 “[图片]” 标记，不带 Base64；状态/思考/HTML/隐藏指令已排除。
 * 返回多行文本，每行「[时间] 名字：内容」。
 */
export function extractSummarizableText(messages, character) {
  const lines = [];
  const myName = character?.myName || '我';
  const realName = character?.realName || '对方';
  for (const msg of messages || []) {
    if (isExcludedFromSummary(msg, character)) continue;
    const name = msg.role === 'user' ? myName : realName;
    const time = formatSummaryTime(msg.timestamp);
    let text = '';
    if (msg.role === 'user') {
      const quoted = serializeUserMessage(msg, character);
      if (quoted !== null) {
        text = quoted;
      } else {
        const parts = effectiveParts(msg).filter((p) => p.type === 'text');
        text = parts.map((p) => extractProtocolText(p.text || '')).join('') || extractProtocolText(messageText(msg));
      }
      if (effectiveParts(msg).some((p) => p.type === 'image')) text += (text ? ' ' : '') + '[图片]';
    } else {
      const seg = classifyContent(msg.content || '', character || {}, {});
      const segs = seg.kind === 'mixed' ? seg.segments : [seg];
      text = segs.map(segmentSummaryText).filter(Boolean).join('\n');
      if (effectiveParts(msg).some((p) => p.type === 'image')) text += (text ? '\n' : '') + '[图片]';
    }
    text = cleanSummaryLine(text);
    if (!text) continue;
    lines.push(`[${time}] ${name}：${text}`);
  }
  return lines.join('\n');
}

/** 组装一次总结调用的 messages：系统提示词（用户可编辑的提示词 + 长度档）+ 聊天记录。 */
export function buildSummaryRequest({ prompt, length = 'medium', transcript }) {
  const len = SUMMARY_LENGTHS[length] || SUMMARY_LENGTHS.medium;
  const system = `${String(prompt || DEFAULT_SUMMARY_PROMPT).trim()}\n\n${len.instruction}`;
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `下面是需要总结的聊天记录：\n\n${transcript || ''}` },
    ],
  };
}

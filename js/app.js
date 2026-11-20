// app.js — UWU 聊天第一阶段：独立聊天界面。
// 模块分工：promptBuilder（提示词）/ historyBuilder（上下文）/ providerAdapter（网络）/
// replyParser（解析）/ storage（持久化）/ importExport（导入导出）。本文件只做界面与编排。
import { buildSystemPrompt, resolvePromptVersion } from './promptBuilder.js';
import { buildRequest, effectiveParts, extractProtocolText, messageText } from './historyBuilder.js';
import { parseReplyText, segmentToMessage, classifyContent, parseBilingual } from './replyParser.js';
import { sendChat, testConnection } from './providerAdapter.js';
import { IDBBackend, MemoryBackend, PAGE_SIZE, templateIdFor, saveStatusTemplate } from './storage.js';
import { decodeBackupBytes, describeBackupBytes, gzipBytes, normalizeBackup, previewCounts, importNormalized, exportAll } from './importExport.js';
import { mockReplyText, MOCK_BADGE } from './mockReply.js';
import { LiquidGlass } from './liquidGlass.js';
import { ThemeStore } from './theme.js';
import { MomentsView } from './moments.js';
import { NavShell } from './nav.js';
import { ManageView } from './manage.js';
import { uid, escapeHtml, friendlyErrorMessage, formatTimeDivider, formatTimeGap, countTextTokens, hashString } from './utils.js';
import { applyStatusTemplate, summarizeStatus, buildStatusDocument, STATUS_HEIGHT_MSG, STATUS_ERROR_MSG } from './statusBar.js';

const $ = (s) => document.querySelector(s);
const messageArea = $('#message-area');
const inputEl = $('#input');
const isCoarse = window.matchMedia?.('(pointer: coarse)').matches;

const backend = new IDBBackend();
let char = null;            // 当前角色（memoryJournals 已从 journals 表合并进来）
let worldBooks = [];
let stickers = [];
let apiSettings = { provider: 'openai', url: '', key: '', model: '', temperatureEnabled: false, temperature: 1.0, streamEnabled: true, timePerceptionEnabled: false };
let apiPresets = [];
let appearanceSettings = null; // 外观/背景/玻璃参数（settings 表 'appearance'），不随备份导出
// 全局提示词设置：导入备份的 cotSettings 落在这里（settings 表 'cotSettings'），
// 角色未指定专属版本时跟随它；缺省为 tt。之前这里写死 'tt'，导入的设置根本没用上。
let globalSettings = { cotSettings: { promptVersion: 'tt' } };
// 最近一次构建的请求：预览与 Get Reply 共用同一份；历史/设置一变就失效重建。
let lastBuiltRequest = null;
let currentQuote = null;
let isGenerating = false;
let abortController = null;
let streamBuf = '';
let loadedOldest = null;    // 已加载窗口的最早时间戳
let hasMoreHistory = false;
let editingMessageId = null;
let longPressTimer = null;
let objectUrlCache = new Map();
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

/* ---------------- 消息渲染 ---------------- */
function allowedStickerNames() {
  const groups = String(char?.stickerGroups || '').split(/[,，]/).map((s) => s.trim()).filter((s) => s && s !== '未分类');
  return stickers.filter((s) => groups.includes(s.group)).map((s) => s.name);
}
function findSticker(name) { return stickers.find((s) => s.name === name); }

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

async function createMessageElement(msg, isContinuous = false) {
  const wrap = el('div', `msg ${msg.role === 'user' ? 'sent' : 'received'}`);
  wrap.dataset.id = msg.id;
  if (msg.isContextDisabled) wrap.classList.add('context-disabled');
  if (isContinuous) wrap.classList.add('continuous');
  if (msg.isWithdrawn) wrap.classList.add('withdrawn');

  const avatarSrc = msg.role === 'user'
    ? await resolveAvatar(char.myAvatar)
    : await resolveAvatar(char.avatar);
  const avatar = el('img', 'msg-avatar' + (isContinuous ? ' invisible' : ''));
  avatar.src = avatarSrc;
  avatar.alt = '';
  wrap.appendChild(avatar);

  const body = el('div', 'msg-body');
  if (msg.quote) {
    body.appendChild(el('div', 'quote-in-bubble', escapeHtml(msg.quote.content)));
  }
  const contentEls = await renderMessageContent(msg);
  for (const c of contentEls) body.appendChild(c);
  if (msg.mock) body.appendChild(el('span', 'mock-tag', '模拟回复'));
  if (msg.edited) body.appendChild(el('div', 'msg-meta', '已编辑'));
  wrap.appendChild(body);

  // 长按 / 右键菜单
  wrap.addEventListener('contextmenu', (e) => { e.preventDefault(); openMsgMenu(msg, e.clientX, e.clientY); });
  wrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => openMsgMenu(msg, e.clientX, e.clientY), 480);
  });
  ['pointerup', 'pointermove', 'pointercancel'].forEach((ev) => wrap.addEventListener(ev, () => clearTimeout(longPressTimer)));
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
      out.push(img);
    }
    const textPart = parts.find((p) => p.type === 'text');
    if (textPart?.text && !textPart.text.includes('发来了一张图片')) {
      out.push(el('div', 'bubble', escapeHtml(textPart.text)));
    }
    if (out.length) return out;
  }

  const seg = classifyContent(msg.content || '', char, { allowedStickers: allowedStickerNames() });
  const segs = seg.kind === 'mixed' ? seg.segments : [seg];
  for (const s of segs) {
    const node = await renderSegment(msg, s);
    if (node) out.push(node);
  }
  if (!out.length) out.push(el('div', 'bubble', escapeHtml(msg.content || '')));
  return out;
}

async function renderSegment(msg, s) {
  switch (s.kind) {
    case 'bilingual': {
      const b = el('div', 'bubble');
      b.appendChild(document.createTextNode(s.foreign));
      const t = el('span', 'translation hidden-t', escapeHtml(s.chinese));
      const btn = el('button', 'toggle-t', '查看翻译');
      btn.onclick = () => {
        const hidden = t.classList.toggle('hidden-t');
        btn.textContent = hidden ? '查看翻译' : '收起翻译';
      };
      b.appendChild(t); b.appendChild(btn);
      return b;
    }
    case 'text': {
      const { inner, bi } = protocolBody(s.content);
      if (bi) {
        const b = el('div', 'bubble');
        b.appendChild(document.createTextNode(bi.foreign));
        const t = el('span', 'translation hidden-t', escapeHtml(bi.chinese));
        const btn = el('button', 'toggle-t', '查看翻译');
        btn.onclick = () => { const h = t.classList.toggle('hidden-t'); btn.textContent = h ? '查看翻译' : '收起翻译'; };
        b.appendChild(t); b.appendChild(btn);
        return b;
      }
      // plain 可能是用户发的协议文本（[我的消息：…]）或导入的纯文本，
      // protocolBody 会剥掉协议外壳，只显示正文。
      return el('div', 'bubble', escapeHtml(inner));
    }
    case 'quote': {
      const b = el('div', 'bubble');
      const q = el('span', 'quote-in-bubble', escapeHtml(s.quoted));
      b.appendChild(q);
      b.appendChild(document.createTextNode(s.reply));
      return b;
    }
    case 'sticker': {
      const st = findSticker(s.name);
      if (st?.attachmentId) {
        const src = await attachmentDataURL(st.attachmentId);
        if (src) { const img = el('img', 'sticker-img'); img.src = src; img.alt = s.name; return img; }
      }
      if (st?.dataUrl) { const img = el('img', 'sticker-img'); img.src = st.dataUrl; img.alt = s.name; return img; }
      return el('div', 'bubble', escapeHtml(`[表情包：${s.name}]`));
    }
    case 'stickerUnknown':
      return el('div', 'bubble', escapeHtml(`[表情包：${s.name}]（未找到该表情包）`));
    case 'photo': {
      const galleryHit = (char.gallery || []).find((g) => g.name === s.body);
      if (galleryHit?.url) {
        const img = el('img', 'photo-img');
        img.src = galleryHit.url;
        img.addEventListener('click', () => openImageViewer(galleryHit.url));
        return img;
      }
      const card = el('div', 'card');
      card.innerHTML = `<div class="card-title">照片 / 视频</div><div class="card-sub">${escapeHtml(s.body || '图片描述')}</div><div class="card-status">描述卡 · 非真实照片</div>`;
      return card;
    }
    case 'voice': {
      const dur = Math.max(1, Math.min(60, Math.ceil((s.body || '').length / 3.5)));
      const card = el('div', 'card voice-card');
      const play = el('button', 'voice-play');
      play.innerHTML = '<svg class="icon"><use href="#i-play"></use></svg>';
      const wave = el('div', 'voice-wave');
      for (const h of [7, 12, 17, 10, 20, 14, 8, 18, 12, 21, 9, 15, 19, 11, 16, 8, 13, 10]) {
        const bar = el('i'); bar.style.height = h + 'px'; wave.appendChild(bar);
      }
      const durEl = el('span', 'voice-dur', escapeHtml(`${dur}″`));
      const full = el('div', 'card-sub hidden', escapeHtml(s.body || ''));
      const toggleText = () => full.classList.toggle('hidden');
      play.onclick = toggleText;
      wave.onclick = toggleText;
      card.append(play, wave, durEl);
      const wrap = el('div', '');
      wrap.append(card, full);
      return wrap;
    }
    case 'status':
      return el('div', 'bubble', escapeHtml(`状态已更新为：${s.body || ''}`));
    case 'withdraw':
      return el('div', 'bubble', escapeHtml(s.content));
    case 'transfer': {
      const m = s.content.match(/([0-9]+(?:\.[0-9]+)?)\s*元[；;]?\s*备注[：:](.*)/);
      const amount = m ? m[1] : '';
      const remark = m ? m[2].replace(/\]$/, '') : '';
      const card = el('div', 'card transfer-card');
      const statusText = msg.transferStatus === 'received' ? '已收款' : msg.transferStatus === 'returned' ? '已退回' : '待处理';
      card.innerHTML = `<div class="card-title">转账 ${escapeHtml(amount)} 元</div><div class="card-sub">备注：${escapeHtml(remark)}</div><div class="card-status">${statusText}</div>`;
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
      card.innerHTML = `<div class="card-title">礼物</div><div class="card-sub">${escapeHtml(s.body || '')}</div><div class="card-status">${statusText}</div>`;
      if (msg.role === 'assistant' && msg.giftStatus === 'sent') {
        const acts = el('div', 'card-actions');
        const ok = el('button', '', '接收礼物');
        ok.onclick = () => receiveGift(msg.id);
        acts.append(ok);
        card.appendChild(acts);
      }
      return card;
    }
    case 'forward':
    case 'html': {
      const card = el('div', 'card placeholder-card');
      const title = s.kind === 'forward' ? '转发的聊天记录（占位）' : 'HTML 卡片（本阶段显示为文字占位）';
      card.innerHTML = `<div class="card-title">${title}</div><details><summary>查看原始内容</summary><div class="card-sub">${escapeHtml(s.content)}</div></details>`;
      return card;
    }
    case 'transferResponse':
    case 'giftResponse':
      return null; // 隐藏指令不显示气泡
    default:
      return el('div', 'bubble', escapeHtml(s.content));
  }
}

function openImageViewer(src) {
  showModal('图片', `<img src="${escapeHtml(src)}" style="max-width:100%;border-radius:10px">`, [{ label: '关闭' }]);
}

async function renderMessages(isLoadMore = false) {
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
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const prev = i > 0 ? messages[i - 1] : null;
    if (!prev || m.timestamp - prev.timestamp > 10 * 60 * 1000 || new Date(m.timestamp).toDateString() !== new Date(prev.timestamp).toDateString()) {
      frag.appendChild(renderTimeDivider(m.timestamp));
    }
    const continuous = !!prev && prev.role === m.role && m.timestamp - prev.timestamp < 10 * 60 * 1000;
    const node = await createMessageElement(m, continuous);
    if (node) frag.appendChild(node);
    lastTime = m.timestamp;
  }
  void lastTime;
  if (isLoadMore) {
    messageArea.prepend(frag);
    messageArea.scrollTop = messageArea.scrollHeight - oldHeight;
  } else {
    messageArea.appendChild(frag);
    messageArea.scrollTop = messageArea.scrollHeight;
  }
  const oldBtn = $('#load-more-btn');
  if (oldBtn) oldBtn.remove();
  if (hasMoreHistory) {
    const btn = el('button', 'load-more', '加载更早的消息');
    btn.id = 'load-more-btn';
    btn.onclick = () => renderMessages(true);
    messageArea.prepend(btn);
  }
}

async function appendMessageElement(msg) {
  const count = await backend.countMessages(char.id);
  void count;
  const all = await backend.getMessagesPage(char.id, { before: msg.timestamp + 1, limit: 2 });
  const prev = all.messages.find((m) => m.id !== msg.id);
  const continuous = !!prev && prev.role === msg.role && msg.timestamp - prev.timestamp < 10 * 60 * 1000;
  const node = await createMessageElement(msg, continuous);
  if (node) {
    messageArea.appendChild(node);
    messageArea.scrollTop = messageArea.scrollHeight;
  }
}

function updateHeader() {
  $('#char-name').textContent = char.remarkName || char.realName || '角色';
  $('#char-status').textContent = char.status || '在线';
  resolveAvatar(char.avatar).then((src) => { $('#char-avatar').src = src; ManageView.refreshHome(src); });
  $('#mock-badge').classList.toggle('hidden', !!apiSettings.key);
  $('#mock-badge').textContent = apiSettings.key ? '' : '模拟';
  $('#mock-badge').title = apiSettings.key ? '' : MOCK_BADGE;
  $('#auto-reply-toggle').checked = localStorage.getItem('uwu-chat.autoReply') === '1';
  renderStatusStrip();
}

// 状态条 chips：只放简短纯文本摘要（顶栏短状态 + 自定义状态原文摘要），
// 绝不把整段协议文本、HTML 或 CSS 放进 chip。
function renderStatusStrip() {
  const strip = $('#status-strip');
  if (!strip) return;
  const items = [];
  if (char.status) items.push(summarizeStatus(char.status));
  const sp = char.statusPanel || {};
  if (sp.currentStatusRaw) items.push(summarizeStatus(sp.currentStatusRaw));
  if (sp.history?.length && sp.history[0].raw && sp.history[0].raw !== sp.currentStatusRaw) items.push(summarizeStatus(sp.history[0].raw));
  const uniq = [...new Set(items)].filter(Boolean);
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
    msg.quote = { messageId: currentQuote.messageId, senderId: currentQuote.senderId || 'assistant', content: currentQuote.content };
    clearQuote();
  }
  if (opts.extraParts) msg.parts = [...msg.parts, ...opts.extraParts];
  if (opts.kind) msg.kind = opts.kind;
  await backend.put('messages', msg);
  await appendMessageElement(msg);
  setSaveState('已保存');
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
  await backend.put('messages', msg);
  await appendMessageElement(msg);
  setSaveState('已保存');
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

/**
 * 构建一次请求（提示词 + 上下文 + 请求体），「本次发送内容预览」与 Get Reply 共用同一份结果。
 * 历史、角色设定、世界书、表情包、API 选项任一变化都会改变签名，缓存失效重建；
 * 否则直接复用上一次的构建对象，不重新构建。只取尾部 maxMemory 条进签名，
 * 因为更早的消息本来就不会进请求。
 */
async function buildCurrentRequest() {
  const history = await backend.getAllMessages(char.id);
  const last = history[history.length - 1];
  const maxMem = Math.max(1, parseInt(char?.maxMemory, 10) || 80);
  const tail = history.slice(-maxMem).map((m) => `${m.id}:${m.updatedAt || m.timestamp}`).join(',');
  const sig = hashString(JSON.stringify({
    c: char.id, h: history.length, l: last?.id || '', t: last?.timestamp || 0, tail,
    p: apiSettings.provider || 'openai', tp: !!apiSettings.timePerceptionEnabled,
    v: resolvePromptVersion(char, globalSettings),
    ch: [char.persona, char.myPersona, char.worldBookIds, char.stickerGroups, char.bilingualModeEnabled, char.replyCountMin, char.replyCountMax, char.maxMemory, char.promptOverride, char.statusPanel],
    wb: worldBooks, st: stickers,
  }));
  if (lastBuiltRequest && lastBuiltRequest.sig === sig) {
    return { ...lastBuiltRequest, reused: true };
  }
  const sys = buildSystemPrompt(char, { worldBooks, stickers, globalSettings });
  const hydrated = await hydrateForRequest(history);
  const req = buildRequest(char, hydrated, sys, { provider: apiSettings.provider || 'openai', timePerceptionEnabled: apiSettings.timePerceptionEnabled });
  lastBuiltRequest = { sig, sys, req, history, reused: false };
  return lastBuiltRequest;
}

function setGenerating(on, label) {
  isGenerating = on;
  const btn = $('#get-reply-btn');
  btn.disabled = false;
  btn.textContent = on ? (label || '停止生成') : 'get reply';
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
  const roundId = uid('round');
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
    const { req } = await buildCurrentRequest();
    const streamBox = await createStreamingBubble();
    const { text } = await sendChat(apiSettings, req.body, {
      signal: abortController.signal,
      onDelta: (d) => { streamBuf += d; updateStreamingBubble(streamBox, streamBuf); },
    });
    streamBuf = text || streamBuf;
    removeStreamingBubble(streamBox);
    await handleAiReplyContent(streamBuf, roundId, {});
  } catch (e) {
    if (e?.name === 'AbortError' || abortController?.signal.aborted) {
      // 停止：已解析出的完整片段照常落库，未闭合片段保留为纯文本
      if (streamBuf.trim()) {
        toast('已停止生成');
        await handleAiReplyContent(streamBuf, roundId, { partial: true });
      }
    } else {
      showApiErrorModal(e);
    }
  } finally {
    setGenerating(false);
    abortController = null;
    streamBuf = '';
  }
}

function showApiErrorModal(e) {
  const friendly = friendlyErrorMessage(e);
  showModal('出错了', `<p>${escapeHtml(friendly)}</p><p class="muted">已发送的消息没有丢失，可以重试。</p>`, [
    { label: '重试', primary: true, onClick: () => getReply() },
    { label: '关闭' },
  ]);
}

async function createStreamingBubble() {
  const wrap = el('div', 'msg received');
  const avatar = el('img', 'msg-avatar');
  avatar.src = await resolveAvatar(char.avatar);
  const body = el('div', 'msg-body');
  const bubble = el('div', 'bubble', '');
  body.appendChild(bubble);
  wrap.append(avatar, body);
  messageArea.appendChild(wrap);
  messageArea.scrollTop = messageArea.scrollHeight;
  return { wrap, bubble };
}
function updateStreamingBubble(box, text) {
  if (!box) return;
  // 流式过程只显示纯文本预览，不执行协议指令
  box.bubble.textContent = text.replace(/^\[.*?(?:消息|回复)[：:]/, '').slice(0, 600);
  messageArea.scrollTop = messageArea.scrollHeight;
}
function removeStreamingBubble(box) { box?.wrap.remove(); }

async function handleAiReplyContent(raw, roundId, opts = {}) {
  let text = String(raw || '');
  // 思维链：本阶段不启用；模型若输出 <thinking>，只取其后的可见部分
  const thinkEnd = text.lastIndexOf('</thinking>');
  if (thinkEnd !== -1) text = text.slice(thinkEnd + '</thinking>'.length);
  text = text.replace(/\[incipere\]/g, '');
  if (!text.trim()) { if (!opts.partial) toast('模型返回了空内容'); return; }

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
      await renderMessages(false);
    }, 2000);
    return;
  }

  // 短状态更新：改顶栏，不显示成普通气泡
  if (seg.kind === 'status') {
    char.status = seg.body || char.status;
    msg.isStatusUpdate = true;
    msg.statusText = seg.body;
    await backend.put('messages', msg);
    await saveCharacter();
    updateHeader();
    const note = el('div', 'msg system-note');
    note.appendChild(el('div', 'bubble', escapeHtml(`状态已更新为：${seg.body || ''}`)));
    messageArea.appendChild(note);
    messageArea.scrollTop = messageArea.scrollHeight;
    return;
  }

  // 用户自定义状态栏：regex/replace 模板去重保存，消息只存引用与原文
  if (char.statusPanel?.enabled && char.statusPanel.regexPattern) {
    try {
      const out = applyStatusTemplate(seg.content, char.statusPanel);
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
        if (!$('#status-panel').classList.contains('hidden')) renderStatusPanel();
      }
    } catch (e) { console.warn('状态栏正则解析错误', e); }
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

/* ---------------- 消息操作 ---------------- */
function openMsgMenu(msg, x, y) {
  const box = $('#msg-menu-actions');
  box.innerHTML = '';
  const add = (label, fn, danger) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (danger) b.style.color = '#b0442f';
    b.onclick = () => { closeSheet('#msg-menu'); fn(); };
    box.appendChild(b);
  };
  add('复制', () => {
    const text = msg.role === 'user' || msg.role === 'assistant'
      ? extractProtocolText(messageText(msg)) || msg.content : msg.content;
    navigator.clipboard?.writeText(text).then(() => toast('已复制'));
  });
  add('引用回复', () => startQuote(msg));
  if (msg.role === 'user') {
    add('编辑', () => startEditMessage(msg));
    if (Date.now() - msg.timestamp <= 2 * 60 * 1000 && !msg.isWithdrawn) {
      add('撤回（2 分钟内）', () => withdrawMessage(msg));
    }
  }
  add(msg.isContextDisabled ? '恢复进上下文' : '不进入上下文', async () => {
    msg.isContextDisabled = !msg.isContextDisabled;
    await backend.put('messages', msg);
    await renderMessages(false);
    toast(msg.isContextDisabled ? '已设为不进入上下文' : '已恢复进上下文');
  });
  if (msg.role === 'assistant') add('重新生成这一轮', () => handleRegenerate());
  add('查看原始内容', () => {
    showModal('原始内容', `<pre class="code">${escapeHtml(JSON.stringify(msg, null, 2))}</pre>`, [{ label: '关闭' }]);
  });
  add('删除', async () => {
    await backend.delete('messages', msg.id);
    await renderMessages(false);
    toast('已删除');
  }, true);
  openSheet('#msg-menu');
  void x; void y;
}

function startQuote(msg) {
  const plain = extractProtocolText(messageText(msg)) || msg.content;
  currentQuote = { messageId: msg.id, senderId: msg.role === 'user' ? 'user_me' : 'assistant', content: plain.slice(0, 120) };
  $('#quote-text').textContent = `引用：${currentQuote.content}`;
  $('#quote-bar').classList.remove('hidden');
  inputEl.focus();
}
function clearQuote() {
  currentQuote = null;
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

async function withdrawMessage(msg) {
  const clean = extractProtocolText(messageText(msg)) || msg.content;
  msg.isWithdrawn = true;
  msg.originalContent = clean;
  const name = char.myName || '我';
  msg.content = `[${name} 撤回了一条消息：${clean}]`;
  msg.parts = [{ type: 'text', text: msg.content }];
  await backend.put('messages', msg);
  await renderMessages(false);
  toast('消息已撤回');
}

/* ---------------- 输入区 ---------------- */
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px';
}
inputEl.addEventListener('input', () => { autoGrow(); $('#composer').classList.toggle('has-text', !!inputEl.value.trim()); });
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
  await sendUserText(text);
  if (localStorage.getItem('uwu-chat.autoReply') === '1') await getReply();
}
$('#send-btn').addEventListener('click', sendCurrent);
$('#get-reply-btn').addEventListener('click', getReply);
$('#quote-cancel').addEventListener('click', clearQuote);
$('#auto-reply-toggle').addEventListener('change', (e) => {
  localStorage.setItem('uwu-chat.autoReply', e.target.checked ? '1' : '0');
});
$('#char-status').addEventListener('click', () => {
  const panel = $('#status-panel');
  panel.classList.toggle('hidden');
  renderStatusPanel();
});
$('#status-panel-close').addEventListener('click', () => $('#status-panel').classList.add('hidden'));
$('#status-btn').addEventListener('click', () => {
  const panel = $('#status-panel');
  panel.classList.toggle('hidden');
  renderStatusPanel();
});
$('#chat-menu-btn').addEventListener('click', () => { openSettings('persona'); });
$('#status-strip').addEventListener('click', () => {
  const panel = $('#status-panel');
  panel.classList.toggle('hidden');
  $('#status-strip').classList.toggle('open', !panel.classList.contains('hidden'));
  renderStatusPanel();
});

/* ---------------- 自定义状态栏：沙箱 iframe 隔离渲染 ----------------
 *  模板 HTML 绝不直接 innerHTML 进主页面。它只活在 sandbox="allow-scripts"
 *  且不带 allow-same-origin 的 iframe 里（srcdoc），模板样式只作用于状态栏内部，
 *  脚本也拿不到主页面、聊天数据与 API Key。高度由 iframe 内的脚本 postMessage
 *  上报（跨沙箱边界可用），父页面只认当前 iframe 的 contentWindow 发来的消息。 */
let statusFrame = null;
let statusFrameHeightOk = false;
let statusFrameTimer = null;

window.addEventListener('message', (e) => {
  if (!statusFrame || e.source !== statusFrame.contentWindow) return;
  const d = e.data || {};
  if (d.type === STATUS_HEIGHT_MSG && Number.isFinite(d.height)) {
    statusFrameHeightOk = true;
    clearTimeout(statusFrameTimer);
    // 只清“加载超时”的提示：模板脚本报错的提示要留着，别被随后到达的高度消息冲掉
    document.querySelector('#status-custom .status-error[data-kind="timeout"]')?.remove();
    statusFrame.style.height = `${Math.max(24, Math.min(d.height, 6000))}px`;
  } else if (d.type === STATUS_ERROR_MSG) {
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
    const out = applyStatusTemplate(sp.currentStatusRaw, sp);
    if (!out) return false;
    await saveStatusTemplate(backend, sp);
    sp.currentStatusHtml = out.html;
    await saveCharacter();
    updateHeader();
    if (!$('#status-panel').classList.contains('hidden')) renderStatusPanel();
    return true;
  } catch (e) { console.warn('状态栏预览重生成失败', e); return false; }
}

function renderStatusPanel() {
  const sp = char.statusPanel || {};
  const host = $('#status-custom');
  host.innerHTML = '';
  statusFrame = null;
  statusFrameHeightOk = false;
  clearTimeout(statusFrameTimer);
  // 旧数据补救：有原始状态但没有渲染产物时，用当前模板就地重算一次
  if (sp.currentStatusRaw && !sp.currentStatusHtml && sp.regexPattern) {
    try {
      const out = applyStatusTemplate(sp.currentStatusRaw, sp);
      if (out) { sp.currentStatusHtml = out.html; saveCharacter(); }
    } catch (e) { /* 保持空态，下面显示提示 */ }
  }
  if (sp.currentStatusHtml) {
    const frame = document.createElement('iframe');
    frame.className = 'status-frame';
    frame.title = '自定义状态栏';
    frame.setAttribute('sandbox', 'allow-scripts allow-popups');
    frame.setAttribute('scrolling', 'no');
    frame.style.height = '120px'; // 首条高度消息到达前的占位
    frame.srcdoc = buildStatusDocument(sp.currentStatusHtml, { marker: `regen ${Date.now()}` });
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
    empty.textContent = sp.currentStatusRaw
      ? '原始状态与当前模板不匹配，无法渲染'
      : '暂无自定义状态栏内容';
    host.appendChild(empty);
  }
  renderStatusDetails(sp);
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
function renderStatusDetails(sp) {
  const rawBox = $('#status-raw');
  const histBox = $('#status-history');
  rawBox.innerHTML = '';
  histBox.innerHTML = '';
  if (sp.currentStatusRaw) rawBox.appendChild(makeStatusDetails('原始文本', sp.currentStatusRaw));
  if (sp.currentStatusHtml) rawBox.appendChild(makeStatusDetails('HTML 源码', sp.currentStatusHtml));
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

async function renderStickerPicker() {
  const grid = $('#sticker-grid');
  grid.innerHTML = '';
  $('#sticker-count').textContent = `共 ${stickers.length} 个`;
  for (const st of stickers) {
    const cell = el('button', 'sticker-cell');
    let src = st.dataUrl || null;
    if (!src && st.attachmentId) src = await attachmentDataURL(st.attachmentId);
    if (src) { const img = el('img'); img.src = src; img.alt = st.name; cell.appendChild(img); }
    else cell.appendChild(el('div', '', '<svg class="icon"><use href="#i-image"></use></svg>'));
    cell.appendChild(el('div', 'nm', escapeHtml(`${st.name} · ${st.group || ''}`)));
    cell.onclick = async () => {
      closeSheet('#sticker-sheet');
      const content = `[${char.myName}的表情包：${st.name}]`;
      const m = { id: uid('msg'), charId: char.id, role: 'user', content, parts: [{ type: 'text', text: content }], timestamp: nextTs(), stickerName: st.name };
      await backend.put('messages', m);
      await appendMessageElement(m);
    };
    grid.appendChild(cell);
  }
  if (!stickers.length) grid.innerHTML = '<p class="muted">还没有表情包，去管理 → 贴纸导入。</p>';
}

/* ---------------- 设置面板 ---------------- */
const TABS = ['persona', 'prompt', 'worldbook', 'memory', 'stickers', 'api', 'data'];
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
  char.statusPanel = {
    ...(char.statusPanel || {}),
    enabled: document.getElementById('f-sp-enabled')?.checked ?? false,
    promptSuffix: inputVal('f-sp-suffix'),
    regexPattern: inputVal('f-sp-regex'),
    replacePattern: inputVal('f-sp-replace'),
    historyLimit: Math.max(0, parseInt(inputVal('f-sp-history') || '3', 10)),
  };
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
      ${field('双语模式', `<label class="check"><input type="checkbox" id="f-bilingual" ${char.bilingualModeEnabled ? 'checked' : ''}> 开启（原文 + 译文分开显示）</label>`)}
      ${field('可用表情包分组（逗号分隔）', `<input type="text" id="f-stickerGroups" value="${esc(char.stickerGroups || '')}">`)}
      ${field('照片库', `<label class="check"><input type="checkbox" id="f-useGallery" ${char.useRealGallery ? 'checked' : ''}> 使用真实照片库（角色照片/视频描述里按名称匹配）</label>`)}
      <h3>用户自定义状态栏</h3>
      ${field('启用', `<label class="check"><input type="checkbox" id="f-sp-enabled" ${sp.enabled ? 'checked' : ''}> 启用状态栏正则</label>`)}
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
          <label class="check"><input type="checkbox" data-wb="${wb.id}" ${bound.has(wb.id) ? 'checked' : ''}> <strong>${esc(wb.title)}</strong> <span class="muted">${esc(wb.position || 'before')} · depth ${esc(String(wb.depth ?? 0))}</span></label>
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
    body.innerHTML = `
      <p class="muted">向量检索尚未接入：下面是已保存的记忆摘要（收藏的才会进提示词）。</p>
      <div id="mem-list">${journals.map((j) => `
        <div class="list-item">
          <strong>${esc(j.title || '未命名')}</strong>
          <span class="badge">${j.isFavorited ? '★ 已收藏' : '未收藏'}</span>
          <div class="sub">${esc((j.content || '').slice(0, 160))}</div>
          <div class="hint">来源：${esc(j.source || '手动记录')} · ${esc(j.timestamp ? formatTimeDivider(j.timestamp) : '')}</div>
          <div class="actions-row">
            <button data-mem-fav="${j.id}">${j.isFavorited ? '取消收藏' : '收藏'}</button>
            <button data-mem-edit="${j.id}">编辑</button>
          </div>
        </div>`).join('') || '<p class="muted">还没有记忆摘要。</p>'}</div>
      <h3>新增记忆</h3>
      ${field('标题', `<input type="text" id="mem-title" placeholder="一句话标题">`)}
      ${field('内容', `<textarea id="mem-content" rows="4" placeholder="记忆内容…"></textarea>`)}
      ${field('来源', `<input type="text" id="mem-source" placeholder="来源（如：手动记录 / 第 12 轮对话）">`)}
      <div class="actions-row"><button class="primary" id="mem-save">保存记忆</button></div>`;
    body.querySelectorAll('[data-mem-fav]').forEach((b) => b.addEventListener('click', async () => {
      const j = journals.find((x) => x.id === b.dataset.memFav); if (!j) return;
      j.isFavorited = !j.isFavorited;
      await backend.put('journals', { ...j, charId: char.id });
      renderSettingsBody();
    }));
    body.querySelectorAll('[data-mem-edit]').forEach((b) => b.addEventListener('click', () => {
      const j = journals.find((x) => x.id === b.dataset.memEdit); if (!j) return;
      $('#mem-title').value = j.title || '';
      $('#mem-content').value = j.content || '';
      $('#mem-source').value = j.source || '';
      $('#mem-save').dataset.editId = j.id;
      $('#mem-title').focus();
    }));
    $('#mem-save').addEventListener('click', async () => {
      const editId = $('#mem-save').dataset.editId;
      const j = {
        id: editId || uid('journal'), charId: char.id,
        title: inputVal('mem-title').trim() || '未命名记忆',
        content: inputVal('mem-content'),
        source: inputVal('mem-source') || '手动记录',
        isFavorited: false, timestamp: Date.now(),
      };
      if (editId) {
        const old = journals.find((x) => x.id === editId);
        j.isFavorited = old?.isFavorited || false;
      }
      await backend.put('journals', j);
      await attachJournals(char);
      renderSettingsBody();
      toast('记忆已保存');
    });
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
    body.innerHTML = `
      ${pending ? `<div class="notice">从备份导入的 API 设置已保存但未自动应用，确认无误后点「应用导入的设置」。</div>` : ''}
      <p class="muted">只在你点「测试连接」或「Get Reply」时才调用模型；不做后台请求，不自动重试烧额度。</p>
      ${field('服务商', `<select id="api-provider"><option value="openai" ${apiSettings.provider === 'openai' ? 'selected' : ''}>OpenAI 兼容</option><option value="gemini" ${apiSettings.provider === 'gemini' ? 'selected' : ''}>Gemini 原生</option></select>`, 'Gemini 原生走独立分支，不会把 OpenAI 格式发到 Gemini 接口。')}
      ${field('API 地址（Base URL）', `<input type="text" id="api-url" value="${esc(apiSettings.url || '')}" placeholder="https://api.openai.com/v1">`, '填完整地址；以 /v1 结尾的地址不会被重复拼接。')}
      ${field('API Key', `<input type="password" id="api-key" value="${esc(apiSettings.key || '')}" placeholder="sk-…">`, '只存在本机，不会出现在导出文件和预览里。')}
      ${field('模型', `<input type="text" id="api-model" value="${esc(apiSettings.model || '')}" placeholder="gpt-4o-mini">`)}
      ${field('temperature', `<label class="check"><input type="checkbox" id="api-temp-enabled" ${apiSettings.temperatureEnabled ? 'checked' : ''}> 启用</label><input type="number" id="api-temp" min="0" max="2" step="0.1" value="${esc(String(apiSettings.temperature ?? 1))}">`)}
      ${field('流式输出', `<label class="check"><input type="checkbox" id="api-stream" ${apiSettings.streamEnabled !== false ? 'checked' : ''}> 开启 SSE 流式</label>`)}
      ${field('时间感知', `<label class="check"><input type="checkbox" id="api-time" ${apiSettings.timePerceptionEnabled ? 'checked' : ''}> 在提示词里注入当前时间</label>`)}
      <div class="actions-row">
        <button class="primary" id="api-save">保存 API 设置</button>
        <button id="api-test">测试连接</button>
        ${pending ? '<button id="api-apply-pending">应用导入的设置</button>' : ''}
      </div>
      <div id="api-result"></div>
      <h3>快捷预设</h3>
      <div id="preset-list">${(apiPresets || []).map((p, i) => `<div class="list-item"><strong>${esc(p.name || p.provider || '')}</strong> <span class="muted">${esc(p.url || '')} · ${esc(p.model || '')}</span> <div class="actions-row"><button data-preset-apply="${i}">应用</button><button data-preset-del="${i}">删除</button></div></div>`).join('') || '<p class="muted">暂无预设。</p>'}</div>
      <div class="actions-row"><button id="preset-save">把当前设置存为预设</button></div>`;
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
      <label class="check"><input type="checkbox" id="export-keys"> 导出时包含 API Key（默认不含；勾选后请妥善保管）</label>
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
      <p class="muted">向量检索尚未接入；本阶段只保留数据与扩展接口。MCP 仅保留模块边界，本阶段不提供入口。</p>
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
        const msgs = built.req.body?.messages || [];
        const rows = msgs.map((m) => `<tr><td>${escapeHtml(m.role)}</td><td>${escapeHtml(String(m.content || '').slice(0, 120))}</td></tr>`).join('');
        $('#ctx-body').innerHTML = `
          <div class="kv"><span>提示词版本</span><b>${escapeHtml(built.sys.version || '')}</b></div>
          <div class="kv"><span>消息条数</span><b>${msgs.length}</b></div>
          <div class="kv"><span>预估 token</span><b>${countTextTokens(JSON.stringify(msgs))}</b></div>
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
      <p class="muted">向量记忆同样尚未接入；记忆数据见「记忆」页，收藏的记忆才会进提示词。</p>`;
    return;
  }

  if (settingsTab === 'appearance') {
    ThemeStore.renderAppearance(body);
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
        <tr><td>角色</td><td>${counts.characters}</td></tr>
        <tr><td>消息</td><td>${counts.messages}</td></tr>
        <tr><td>世界书</td><td>${counts.worldBooks}</td></tr>
        <tr><td>记忆</td><td>${counts.journals}</td></tr>
        <tr><td>表情包</td><td>${counts.stickers}</td></tr>
        ${counts.gaps.length ? `<tr><td>待接入</td><td>${escapeHtml(counts.gaps.join('、'))}</td></tr>` : ''}
      </table>
      <label>主角色（进入提示词与聊天）</label>
      <select id="import-main-char">${chars.map((c, i) => `<option value="${i}">${esc(c.remarkName || c.realName || '未命名')}</option>`).join('')}</select>
      <label>导入方式</label>
      <select id="import-mode"><option value="merge">合并（默认，不覆盖已有数据）</option><option value="replace">替换全部数据（先清空现有库，再导入）</option></select>
      ${norm.apiSettings ? '<p class="notice">备份含 API 设置：导入后只保存非 Key 字段待你确认，Key 需在设置里单独填写。</p>' : ''}`,
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
        if (mainId) localStorage.setItem('uwu-chat.lastChar', mainId);
        await loadAll();
        updateHeader();
        await renderMessages(false);
        const skippedTotal = Object.values(report.skipped || {}).reduce((s, n) => s + (n || 0), 0);
        const rep = $('#import-report');
        if (rep) rep.innerHTML = `<div class="notice">导入完成：新增 ${report.added.characters || 0} 个角色、${report.added.messages || 0} 条消息、${report.added.worldBooks || 0} 本世界书、${report.added.journals || 0} 条记忆、${report.added.stickers || 0} 个表情包；跳过重复 ${skippedTotal} 条${report.conflicts.length ? `；冲突 ${report.conflicts.length} 条：${escapeHtml(report.conflicts[0] || '')}` : ''}${(report.unknownPreserved || []).length ? `；待接入（原样保存）：${escapeHtml(report.unknownPreserved.join('、'))}` : ''}。</div>`;
        toast('导入完成');
      } },
    ]);
  } catch (e) {
    console.warn(e);
    showImportFailure(label, buf, e);
  }
}

async function showSendPreview() {
  try {
    const { sys, req, reused } = await buildCurrentRequest();
    const msgs = req.body.messages || req.body.contents || [];
    const tokens = sys.tokenEstimate + countTextTokens(JSON.stringify(msgs));
    const sysText = req.systemPrompt || sys.systemPrompt;
    showModal('本次发送内容预览', `
      <p class="muted">与 Get Reply 发送的是同一份构建结果（${reused ? '直接复用刚才的构建，未重新构建' : '本次新构建'}）；API Key 不显示。</p>
      <table class="preview-table">
        <tr><td>服务商</td><td>${esc(apiSettings.provider || 'openai')}</td></tr>
        <tr><td>模型</td><td>${esc(apiSettings.model || '（未填）')}</td></tr>
        <tr><td>提示词版本</td><td>${esc(sys.version)}</td></tr>
        <tr><td>消息数（请求内）</td><td>${msgs.length} 条（历史 ${req.stats.historyMessages} 条，进请求前已按 maxMemory ${req.stats.maxMemory} 截断；不进上下文 ${req.stats.droppedContextDisabled} 条）</td></tr>
        <tr><td>Token（估算）</td><td>约 ${tokens}（估算值，非官方计费口径）</td></tr>
      </table>
      <label>模块来源（Token 估算）</label>
      <table class="preview-table">${sys.modules.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.source)}</td><td>约 ${m.tokens}</td></tr>`).join('')}</table>
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
async function boot() {
  try {
    await backend.init();
    await loadAll();
    LiquidGlass.init({ canvas: document.getElementById('gl-canvas'), onContextLost: () => toast('WebGL 已停用，已切换为 CSS 玻璃') });
    ThemeStore.init(backend, appearanceSettings);
    NavShell.init();
    // Register static and dynamically rendered surfaces with the supplied refraction engine.
    const selectors = '.glass, .bubble, .post, .group, .card, .m-ico, .post-action';
    let glassSyncPending = false;
    const syncGlass = () => {
      glassSyncPending = false;
      document.querySelectorAll(selectors).forEach((node) => { node.classList.add('glass'); LiquidGlass.attach(node); });
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
    await renderMessages(false);
    // 保存失败提示
    const origPut = backend.put.bind(backend);
    backend.put = async (...args) => {
      try { return await origPut(...args); }
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

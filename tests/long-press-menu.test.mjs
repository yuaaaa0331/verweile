import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LONG_PRESS_MS, REACTION_EMOJIS, RECALL_WINDOW_MS,
  messageKind, isOwnMessage, isAssistantMessage, canRecall, canEdit,
  getMenuItems, getSecondaryItems, toggleReaction, reactionCounts, hasMyReaction,
  createDeleteToken, isDeleteTokenValid, computeMenuPlacement, LongPressMenu,
} from '../js/longPressMenu.js';

const NOW = 1_800_000_000_000;
const userText = (over = {}) => ({
  id: 'm1', role: 'user', content: '你好', timestamp: NOW - 30_000, ...over,
});
const aiText = (over = {}) => ({
  id: 'm2', role: 'assistant', content: '你好呀', timestamp: NOW - 30_000, ...over,
});

test('messageKind / isOwnMessage / isAssistantMessage', () => {
  assert.equal(messageKind({ role: 'user', content: 'hi' }), 'text');
  assert.equal(messageKind({ parts: [{ type: 'image', attachmentId: 'a' }] }), 'image');
  assert.equal(messageKind({ kind: 'transfer' }), 'transfer');
  assert.equal(messageKind({ isStatusUpdate: true }), 'status');
  assert.equal(isOwnMessage(userText()), true);
  assert.equal(isOwnMessage(aiText()), false);
  assert.equal(isAssistantMessage(aiText()), true);
});

test('canRecall：仅自己的消息、未撤回、2 分钟内', () => {
  assert.equal(canRecall(userText(), NOW), true);
  assert.equal(canRecall(userText({ timestamp: NOW - RECALL_WINDOW_MS }), NOW), true);
  assert.equal(canRecall(userText({ timestamp: NOW - RECALL_WINDOW_MS - 1 }), NOW), false);
  assert.equal(canRecall(userText({ timestamp: NOW - 3 * 60_000 }), NOW), false);
  assert.equal(canRecall(aiText(), NOW), false);
  assert.equal(canRecall(userText({ isWithdrawn: true }), NOW), false);
});

test('canEdit：仅自己的、未撤回的文本消息', () => {
  assert.equal(canEdit(userText()), true);
  assert.equal(canEdit(aiText()), false);
  assert.equal(canEdit(userText({ isWithdrawn: true })), false);
  assert.equal(canEdit(userText({ parts: [{ type: 'image' }] })), false);
});

test('getMenuItems：用户文本消息的优先级顺序', () => {
  const ids = getMenuItems(userText(), NOW).map((i) => i.id);
  assert.deepEqual(ids, ['copy', 'quote', 'favorite', 'select', 'edit', 'recall', 'delete']);
  const del = getMenuItems(userText(), NOW).find((i) => i.id === 'delete');
  assert.equal(del.danger, true);
});

test('getMenuItems：AI 回复有重新生成、无编辑/撤回；旧消息无撤回', () => {
  const aiIds = getMenuItems(aiText(), NOW).map((i) => i.id);
  assert.deepEqual(aiIds, ['copy', 'quote', 'favorite', 'select', 'regenerate', 'delete']);
  const oldIds = getMenuItems(userText({ timestamp: NOW - 10 * 60_000 }), NOW).map((i) => i.id);
  assert.deepEqual(oldIds, ['copy', 'quote', 'favorite', 'select', 'edit', 'delete']);
});

test('getMenuItems：状态消息与已撤回消息被过滤', () => {
  assert.deepEqual(getMenuItems({ isStatusUpdate: true }, NOW).map((i) => i.id), ['select']);
  assert.deepEqual(
    getMenuItems(userText({ isWithdrawn: true }), NOW).map((i) => i.id),
    ['select', 'delete'],
  );
});

test('getSecondaryItems：上下文开关进次级入口，标签随状态翻转', () => {
  const items = getSecondaryItems(userText());
  assert.deepEqual(items.map((i) => i.id), ['toggleContext', 'viewRaw']);
  assert.equal(items[0].label, '不进入上下文');
  assert.equal(getSecondaryItems(userText({ isContextDisabled: true }))[0].label, '恢复进上下文');
});

test('toggleReaction：纯函数，重复点击取消，不改原对象', () => {
  const msg = aiText({ reactions: [{ emoji: '👍', by: 'char', ts: 1 }] });
  const added = toggleReaction(msg, '❤️', NOW);
  assert.equal(msg.reactions.length, 1); // 原对象不动
  assert.equal(added.reactions.length, 2);
  assert.deepEqual(added.reactions[1], { emoji: '❤️', by: 'me', ts: NOW });
  assert.equal(hasMyReaction(added, '❤️'), true);
  const removed = toggleReaction(added, '❤️', NOW + 1);
  assert.equal(removed.reactions.length, 1);
  assert.equal(hasMyReaction(removed, '❤️'), false);
  // 对方的反应不受我切换的影响
  assert.equal(hasMyReaction(added, '👍'), false);
  assert.deepEqual(reactionCounts(added), [
    { emoji: '👍', count: 1, mine: false },
    { emoji: '❤️', count: 1, mine: true },
  ]);
});

test('createDeleteToken / isDeleteTokenValid：5 秒内可撤销', () => {
  const token = createDeleteToken(userText(), NOW);
  assert.equal(token.messageId, 'm1');
  assert.equal(token.snapshot.id, 'm1');
  assert.equal(isDeleteTokenValid(token, NOW), true);
  assert.equal(isDeleteTokenValid(token, NOW + 5000), true);
  assert.equal(isDeleteTokenValid(token, NOW + 5001), false);
  assert.equal(isDeleteTokenValid(null, NOW), false);
});

test('computeMenuPlacement：气泡在底部附近时翻到上方，底部避让键盘/底栏', () => {
  const viewport = { width: 390, height: 844 };
  const menuSize = { width: 280, height: 320 };
  // 气泡贴近顶部 → 菜单在下方，反应条夹在气泡与菜单之间
  const top = computeMenuPlacement(
    { top: 100, bottom: 140, left: 20, right: 300, width: 280, height: 40 },
    menuSize, viewport,
  );
  assert.equal(top.placement, 'below');
  assert.ok(top.reactions.top > 140 && top.menu.top > top.reactions.top);
  // 气泡贴近底部 → 翻到上方
  const bottom = computeMenuPlacement(
    { top: 700, bottom: 740, left: 20, right: 300, width: 280, height: 40 },
    menuSize, viewport,
  );
  assert.equal(bottom.placement, 'above');
  assert.ok(bottom.menu.top + menuSize.height <= 700);
  // 底部有键盘/底栏避让：菜单底缘不进入 reserve 区
  const reserved = computeMenuPlacement(
    { top: 300, bottom: 340, left: 20, right: 300, width: 280, height: 40 },
    menuSize, viewport, { bottomReserve: 300 },
  );
  assert.ok(reserved.menu.top + menuSize.height <= 844 - 300 - 8);
  // 靠右气泡：菜单右缘贴气泡右缘，且不越出视口
  const right = computeMenuPlacement(
    { top: 100, bottom: 140, left: 200, right: 380, width: 180, height: 40 },
    menuSize, viewport,
  );
  assert.equal(right.menu.left + menuSize.width <= 390 - 8, true);
  assert.equal(right.menu.left, 380 - 280);
});

test('REACTION_EMOJIS：与 iOS 参考一致的六个表情', () => {
  assert.deepEqual(REACTION_EMOJIS, ['❤️', '👍', '😂', '🥹', '😮', '🤔']);
});

// ---- 轻量 fake DOM（只够 LongPressMenu 的 DOM 构建用） ----
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.textContent = '';
    this._class = new Set();
    this._listeners = {};
    this.classList = {
      add: (...c) => c.forEach((x) => this._class.add(x)),
      remove: (...c) => c.forEach((x) => this._class.delete(x)),
      contains: (c) => this._class.has(c),
      toggle: (c, force) => {
        const v = force !== undefined ? force : !this._class.has(c);
        if (v) this._class.add(c); else this._class.delete(c);
        return v;
      },
    };
  }
  get className() { return [...this._class].join(' '); }
  set className(v) { this._class = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
  }
  dispatch(type, event = {}) {
    for (const fn of [...(this._listeners[type] || [])]) fn({ target: this, ...event });
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  querySelector(sel) {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    const walk = (el) => {
      for (const c of el.children) {
        if (cls && c.classList.contains(cls)) return c;
        const r = walk(c);
        if (r) return r;
      }
      return null;
    };
    return walk(this);
  }
  querySelectorAll(sel) {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (cls && c.classList.contains(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
    this.documentElement = new FakeElement('html');
    this._listeners = {};
  }
  createElement(tag) { return new FakeElement(tag); }
  createElementNS(_ns, tag) { return new FakeElement(tag); }
  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
  }
  dispatch(type, event = {}) {
    for (const fn of [...(this._listeners[type] || [])]) fn({ target: this, ...event });
  }
}

function setup() {
  const doc = new FakeDocument();
  const selection = { removed: 0, removeAllRanges() { this.removed += 1; } };
  const win = { innerWidth: 390, innerHeight: 844, getSelection: () => selection };
  const scrollContainer = { scrollTop: 120 };
  const anchor = new FakeElement('div');
  anchor.getBoundingClientRect = () => (
    { top: 100, bottom: 140, left: 20, right: 300, width: 280, height: 40 }
  );
  return { doc, win, scrollContainer, anchor, selection };
}

test('LongPressMenu.open/close：建菜单 + 反应条、高亮气泡、恢复滚动位置', () => {
  const { doc, win, scrollContainer, anchor } = setup();
  const menu = new LongPressMenu({}, { document: doc, window: win, scrollContainer });
  scrollContainer.scrollTop = 120;
  const pos = menu.open(userText(), anchor);
  assert.equal(menu.isOpen, true);
  assert.equal(pos.placement, 'below');
  assert.equal(anchor.classList.contains('lp-highlight'), true);
  // 菜单项与反应条都在 DOM 里
  const root = doc.body.children[0];
  assert.equal(root.className, 'lp-menu-root');
  assert.equal(root.querySelectorAll('.lp-menu-item').length, 8); // 7 项 + “更多”
  assert.equal(root.querySelectorAll('.lp-reaction').length, 7); // 6 表情 + 更多
  assert.equal(root.querySelector('.lp-reaction-bar') !== null, true);
  // 抑制了整页选中菜单
  assert.equal(doc.documentElement.style.userSelect, 'none');
  // 关闭：高亮去掉、滚动位置恢复、选中恢复
  scrollContainer.scrollTop = 999;
  menu.close();
  assert.equal(menu.isOpen, false);
  assert.equal(anchor.classList.contains('lp-highlight'), false);
  assert.equal(scrollContainer.scrollTop, 120);
  assert.equal(doc.body.children.length, 0);
  assert.equal(doc.documentElement.style.userSelect, '');
});

test('LongPressMenu：点删除走回调并带可撤销 token，菜单随即关闭', () => {
  const { doc, win, anchor } = setup();
  let deleted = null;
  const menu = new LongPressMenu({
    onDelete: (msg, token) => { deleted = { msg, token }; },
  }, { document: doc, window: win });
  menu.open(userText(), anchor);
  const root = doc.body.children[0];
  const delBtn = root.querySelectorAll('.lp-menu-item').find((b) => b.classList.contains('danger'));
  assert.ok(delBtn, '应有红色删除项');
  delBtn.dispatch('click');
  assert.equal(deleted.msg.id, 'm1');
  assert.equal(deleted.token.messageId, 'm1');
  assert.equal(isDeleteTokenValid(deleted.token, Date.now()), true);
  assert.equal(menu.isOpen, false);
});

test('LongPressMenu：点表情反应切换本地状态并回调，不请求模型', () => {
  const { doc, win, anchor } = setup();
  const reacted = [];
  const menu = new LongPressMenu({
    onReact: (msg, emoji) => reacted.push([msg, emoji]),
  }, { document: doc, window: win });
  menu.open(aiText(), anchor);
  const root = doc.body.children[0];
  const heart = root.querySelectorAll('.lp-reaction')[0];
  assert.equal(heart.textContent, '❤️');
  heart.dispatch('click');
  assert.equal(reacted.length, 1);
  assert.equal(reacted[0][1], '❤️');
  assert.equal(reacted[0][0].reactions.length, 1);
  assert.equal(heart.classList.contains('active'), true);
  // 再点一次取消
  heart.dispatch('click');
  assert.equal(reacted[1][0].reactions.length, 0);
  assert.equal(heart.classList.contains('active'), false);
});

test('LongPressMenu.open：立即清掉原生选区，打开期间 selectionchange 也清掉；关闭后解绑', () => {
  const { doc, win, anchor, selection } = setup();
  const menu = new LongPressMenu({}, { document: doc, window: win });
  menu.open(userText(), anchor);
  assert.ok(selection.removed >= 1, '打开时应清掉已有选区');
  const before = selection.removed;
  doc.dispatch('selectionchange');
  assert.equal(selection.removed, before + 1, '打开期间 selectionchange 应清掉选区');
  menu.close();
  doc.dispatch('selectionchange');
  assert.equal(selection.removed, before + 1, '关闭后不再清选区（监听已解绑）');
});

test('LongPressMenu.attachTo：触屏 pointerdown 尽早 preventDefault，图片目标除外', async () => {
  const { doc, win, anchor } = setup();
  const menu = new LongPressMenu({}, { document: doc, window: win });
  const detach = menu.attachTo(anchor, userText());
  let prevented = 0;
  anchor.dispatch('pointerdown', { pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 120, cancelable: true, preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1, '文本气泡长按应在 pointerdown 就 preventDefault');
  menu.close();
  detach();
  // 图片目标：不拦点击（点图看大图）
  const img = new FakeElement('img');
  const menu2 = new LongPressMenu({}, { document: doc, window: win });
  const detach2 = menu2.attachTo(img, userText());
  let preventedImg = 0;
  img.dispatch('pointerdown', { pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 120, cancelable: true, preventDefault: () => { preventedImg += 1; } });
  assert.equal(preventedImg, 0, '图片目标不 preventDefault，点图看大图不受影响');
  menu2.close();
  detach2();
});

test('LongPressMenu.attachTo：桌面右键打开；触屏长按约 500ms 打开、滑动取消', async () => {
  const { doc, win, anchor } = setup();
  const menu = new LongPressMenu({}, { document: doc, window: win });
  const detach = menu.attachTo(anchor, userText());
  // 右键
  anchor.dispatch('contextmenu', { preventDefault: () => {}, clientX: 50, clientY: 120 });
  assert.equal(menu.isOpen, true);
  menu.close();
  // 触屏长按：500ms 未到不打开
  anchor.dispatch('pointerdown', { pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 120 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(menu.isOpen, false);
  // 滑动超过 10px 取消
  anchor.dispatch('pointermove', { pointerType: 'touch', clientX: 80, clientY: 120 });
  await new Promise((r) => setTimeout(r, LONG_PRESS_MS + 150));
  assert.equal(menu.isOpen, false);
  // 重新长按且不动：打开
  anchor.dispatch('pointerdown', { pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 120 });
  await new Promise((r) => setTimeout(r, LONG_PRESS_MS + 150));
  assert.equal(menu.isOpen, true);
  menu.close();
  detach();
});

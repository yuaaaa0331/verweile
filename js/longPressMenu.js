// longPressMenu.js — iOS 风格长按菜单：纯逻辑 + DOM 构建器。
//
// 与 js/app.js 的关系：本模块不 import app.js，所有动作都走宿主注入的
// 回调（new LongPressMenu({ onCopy, onQuote, … })）。集成时 app.js 的
// attachMsgMenu() / openMsgMenu() 改调本模块，见 docs/chat-audit.md 附表。
// 视觉对照：iOS 长按菜单参考截图（Copy/Save/Reply/Select/Lock/Delete，
// 右侧单色图标，Delete 红色；下方独立表情反应条 ❤️👍😂🥹😮🤔）。
// 本模块只负责逻辑与 DOM 结构，配色/玻璃/圆角由集成轮在 styles.css 里补
// （顶栏与底栏玻璃走 js/liquidGlass.js 的 LiquidGlass 引擎，不手写假玻璃）。

/** 触屏长按阈值（ms）。app.js 现行值是 480，本模块取约 500ms。 */
export const LONG_PRESS_MS = 500;
/** 触发长按前手指可移动的最大距离（px），超过即视为滚动/拖动，取消长按。 */
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
/** 删除可撤销的有效期（ms）。token 过期后撤销入口失效。 */
export const DELETE_UNDO_WINDOW_MS = 5000;
/** 撤回（2 分钟内）窗口，与 app.js withdrawMessage 的规则一致。 */
export const RECALL_WINDOW_MS = 2 * 60 * 1000;
/** 表情反应条的表情（顺序与 iOS 参考截图一致），“更多”由宿主另行展开。 */
export const REACTION_EMOJIS = ['❤️', '👍', '😂', '🥹', '😮', '🤔'];
/** 菜单与气泡/反应条之间的最小间距（px）。 */
export const MENU_GAP_PX = 8;
/** 菜单离视口边缘的最小间距（px）。 */
export const MENU_EDGE_MARGIN_PX = 8;

/** message.reactions 的一条记录：{ emoji, by: 'me' | 'char', ts }。 */
export function reactionEntry(emoji, by = 'me', ts = Date.now()) {
  return { emoji, by, ts };
}

/** 从消息推断种类：供菜单项过滤用。kind 优先取 msg.kind；
 *  其次看 parts 里有没有 image；其余一律按 text 处理。 */
export function messageKind(msg = {}) {
  if (typeof msg.kind === 'string' && msg.kind) return msg.kind;
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  if (parts.some((p) => p && p.type === 'image')) return 'image';
  if (msg.isStatusUpdate) return 'status';
  if (msg.isWithdrawn) return 'withdrawn';
  return 'text';
}

/** 是否自己的消息（可编辑/可撤回的前提）。 */
export function isOwnMessage(msg = {}) {
  return msg.role === 'user';
}

/** 是否 AI 回复（可重新生成的前提）。 */
export function isAssistantMessage(msg = {}) {
  return msg.role === 'assistant';
}

/** 是否在可撤回窗口内：自己的消息、未撤回、2 分钟内。now 可注入，便于测试。 */
export function canRecall(msg = {}, now = Date.now()) {
  if (!isOwnMessage(msg) || msg.isWithdrawn) return false;
  if (!Number.isFinite(msg.timestamp)) return false;
  return now - msg.timestamp <= RECALL_WINDOW_MS;
}

/** 是否可编辑：自己的消息、未撤回、文本类（图片/卡片/状态不进编辑）。 */
export function canEdit(msg = {}) {
  if (!isOwnMessage(msg) || msg.isWithdrawn) return false;
  return messageKind(msg) === 'text';
}

/** 菜单项定义：一级菜单（按优先级排序；删除永远最后且标 danger）。
 *  每项：{ id, label, icon, danger? }，icon 取 index.html 里已有的 SVG symbol id
 *  （#i-copy / #i-reply / #i-star / #i-check / #i-pencil / #i-undo / #i-trash）。
 *  上下文参与开关不在一级菜单里，见 getSecondaryItems()。 */
export function getMenuItems(msg = {}, now = Date.now()) {
  const kind = messageKind(msg);
  const items = [];
  // 复制：文本/图片/卡片消息都有可复制的文本（宿主负责取纯文本）；状态类与已撤回不给复制。
  if (kind !== 'status' && kind !== 'withdrawn') {
    items.push({ id: 'copy', label: '复制', icon: 'i-copy' });
  }
  if (kind === 'text' || kind === 'image') {
    items.push({ id: 'quote', label: '引用回复', icon: 'i-reply' });
  }
  if (kind !== 'status' && kind !== 'withdrawn') {
    items.push({ id: 'favorite', label: '收藏', icon: 'i-star' });
  }
  items.push({ id: 'select', label: '选择', icon: 'i-check' });
  if (canEdit(msg)) {
    items.push({ id: 'edit', label: '编辑', icon: 'i-pencil' });
  }
  if (canRecall(msg, now)) {
    items.push({ id: 'recall', label: '撤回', icon: 'i-undo' });
  }
  if (isAssistantMessage(msg) && kind === 'text') {
    items.push({ id: 'regenerate', label: '重新生成', icon: 'i-sparkle' });
  }
  if (kind !== 'status') {
    items.push({ id: 'delete', label: '删除', icon: 'i-trash', danger: true });
  }
  return items;
}

/** 次级入口（“更多”里展开）：上下文参与开关 + 查看原始内容。
 *  调试开关不在此列——那是调试功能，不应出现在日常长按菜单里。 */
export function getSecondaryItems(msg = {}) {
  const kind = messageKind(msg);
  const items = [];
  if (kind !== 'status' && kind !== 'withdrawn') {
    items.push({
      id: 'toggleContext',
      label: msg.isContextDisabled ? '恢复进上下文' : '不进入上下文',
      icon: 'i-eye',
    });
  }
  items.push({ id: 'viewRaw', label: '查看原始内容', icon: 'i-file' });
  return items;
}

/** 纯函数：切换“我”的某表情反应。返回一个新 message 对象（不改原对象）；
 *  已有则取消（移除我对该表情的记录），没有则追加 { emoji, by:'me', ts }。
 *  反应只存在本地（message.reactions），不请求模型。 */
export function toggleReaction(msg = {}, emoji, now = Date.now()) {
  const reactions = Array.isArray(msg.reactions) ? [...msg.reactions] : [];
  const idx = reactions.findIndex((r) => r && r.emoji === emoji && r.by === 'me');
  if (idx >= 0) reactions.splice(idx, 1);
  else reactions.push({ emoji, by: 'me', ts: now });
  return { ...msg, reactions };
}

/** 纯函数：按表情汇总反应计数，返回 [{ emoji, count, mine }]（按首次出现顺序）。 */
export function reactionCounts(msg = {}) {
  const out = [];
  for (const r of Array.isArray(msg.reactions) ? msg.reactions : []) {
    if (!r || !r.emoji) continue;
    let row = out.find((o) => o.emoji === r.emoji);
    if (!row) { row = { emoji: r.emoji, count: 0, mine: false }; out.push(row); }
    row.count += 1;
    if (r.by === 'me') row.mine = true;
  }
  return out;
}

/** 纯函数：我是否已对该表情反应过。 */
export function hasMyReaction(msg = {}, emoji) {
  return (Array.isArray(msg.reactions) ? msg.reactions : [])
    .some((r) => r && r.emoji === emoji && r.by === 'me');
}

/** 删除可撤销 token：宿主删除消息时把 token 交给 toast，数秒内可点撤销恢复。
 *  token 只带恢复所需快照，不含任何 API 信息。 */
export function createDeleteToken(msg = {}, now = Date.now()) {
  return {
    messageId: msg.id,
    snapshot: { ...msg },
    deletedAt: now,
    validMs: DELETE_UNDO_WINDOW_MS,
  };
}

/** token 是否仍在可撤销窗口内。 */
export function isDeleteTokenValid(token, now = Date.now()) {
  if (!token || !Number.isFinite(token.deletedAt)) return false;
  return now - token.deletedAt <= (token.validMs || DELETE_UNDO_WINDOW_MS);
}

/**
 * 纯函数：根据气泡位置算菜单 + 反应条的落点。
 * @param {Object} anchorRect 气泡的 rect：{ top, bottom, left, right, width, height }
 * @param {Object} menuSize 菜单尺寸：{ width, height }（含反应条高度请另传 reactionBarHeight）
 * @param {Object} viewport 视口：{ width, height }
 * @param {Object} opts { reactionBarHeight=48, bottomReserve=0 }
 *   bottomReserve：底部要避让的高度（键盘高度 + 输入区 + Tab 栏），菜单底缘不进入该区域。
 * @returns { menu: {top,left}, reactions: {top,left}, placement: 'above'|'below' }
 *   规则：气泡下方空间够 → 菜单在气泡下方，反应条夹在气泡与菜单之间；
 *   不够 → 整体翻到气泡上方，反应条夹在菜单与气泡之间；左右钳制在视口内。
 */
export function computeMenuPlacement(anchorRect, menuSize, viewport, opts = {}) {
  const reactionBarHeight = opts.reactionBarHeight ?? 48;
  const bottomReserve = opts.bottomReserve ?? 0;
  const vw = viewport.width;
  const vh = viewport.height;
  const gap = MENU_GAP_PX;
  const margin = MENU_EDGE_MARGIN_PX;
  const menuW = Math.min(menuSize.width, vw - margin * 2);
  const menuH = menuSize.height;
  const totalBelow = gap + reactionBarHeight + gap + menuH;
  const totalAbove = gap + reactionBarHeight + gap + menuH;
  const spaceBelow = (vh - bottomReserve) - anchorRect.bottom;
  const spaceAbove = anchorRect.top;
  const below = spaceBelow >= totalBelow || spaceBelow >= spaceAbove;
  let left = anchorRect.left;
  // 我方气泡靠右：菜单右缘贴气泡右缘；对方气泡靠左：左缘贴气泡左缘；再钳制进视口。
  if (anchorRect.left + anchorRect.width / 2 > vw / 2) {
    left = anchorRect.right - menuW;
  }
  left = Math.max(margin, Math.min(left, vw - menuW - margin));
  let menuTop;
  let reactionsTop;
  if (below) {
    reactionsTop = anchorRect.bottom + gap;
    menuTop = reactionsTop + reactionBarHeight + gap;
    // 底缘仍超 reserve：整体上移钳制，不让菜单被键盘/底栏遮住。
    const maxTop = vh - bottomReserve - menuH - margin;
    if (menuTop > maxTop) menuTop = Math.max(margin, maxTop);
  } else {
    menuTop = anchorRect.top - gap - menuH;
    reactionsTop = menuTop + menuH + gap;
    if (menuTop < margin) menuTop = margin;
  }
  void totalAbove;
  return {
    menu: { top: Math.round(menuTop), left: Math.round(left) },
    reactions: { top: Math.round(reactionsTop), left: Math.round(left) },
    placement: below ? 'below' : 'above',
  };
}

/** 长按菜单的 DOM 构建器 + 手势绑定。
 *
 *  用法（集成轮在 app.js 里）：
 *  ```js
 *  import { LongPressMenu } from './longPressMenu.js';
 *  const menu = new LongPressMenu({
 *    onCopy: (msg) => { … }, onQuote, onFavorite, onSelect, onEdit,
 *    onRecall, onRegenerate, onDelete: (msg, token) => { …toast 撤销… },
 *    onToggleContext, onViewRaw, onReact: (msg, emoji) => { … },
 *  });
 *  menu.attachTo(wrapEl, msg); // 替代现行 attachMsgMenu()
 *  ```
 *  注入点：document/window/scrollContainer 均可注入，便于 Node 测试用 fake DOM。
 */
export class LongPressMenu {
  constructor(callbacks = {}, opts = {}) {
    this.callbacks = callbacks;
    this.doc = opts.document || globalThis.document;
    this.win = opts.window || globalThis.window;
    // 滚动恢复：打开时记下滚动容器的 scrollTop，关闭时还原。
    this.scrollContainer = opts.scrollContainer || null;
    this.menuSize = opts.menuSize || { width: 280, height: 320 };
    this.reactionBarHeight = opts.reactionBarHeight ?? 48;
    this._open = false;
    this._message = null;
    this._anchorEl = null;
    this._root = null;
    this._savedScrollTop = 0;
    this._savedUserSelect = '';
    this._savedTouchCallout = '';
    this._boundDocClick = (e) => this._onDocPointerDown(e);
    this._boundDocContextMenu = (e) => { if (this._open) e.preventDefault(); };
    this._boundKeyDown = (e) => { if (e.key === 'Escape') this.close(); };
    // 菜单打开期间禁止任何原生选区出现：打开时清掉，期间 selectionchange 再清掉。
    this._boundSelectionChange = () => this._clearSelection();
  }

  get isOpen() { return this._open; }
  get currentMessage() { return this._message; }

  /** 把长按/右键手势绑到一条消息的气泡外层元素上（替代 app.js attachMsgMenu）。
   *  触屏：pointerdown 起 500ms 计时；pointermove 超 10px、pointerup/pointercancel、
   *  非主指针（多指）均取消。桌面：contextmenu 打开。 */
  attachTo(el, msg) {
    if (!el || typeof el.addEventListener !== 'function') return () => {};
    let timer = null;
    let startX = 0;
    let startY = 0;
    const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
    const onPointerDown = (e) => {
      if (e.pointerType === 'mouse') return; // 桌面走 contextmenu，不走长按
      if (e.isPrimary === false) { clear(); return; }
      clear();
      startX = e.clientX ?? 0;
      startY = e.clientY ?? 0;
      // 尽早拦住 iOS 原生选词 / 呼出菜单：pointerdown 可取消时就 preventDefault。
      // 图片 / 链接 / 按钮自带点击行为（点图看大图），不拦；输入框不在气泡里，不受影响。
      // 注意：这里拦的是 pointerdown，不是 touchstart，所以不影响从气泡起手的滚动。
      const t = e.target;
      const interactive = t && typeof t.closest === 'function'
        ? t.closest('img, a, button, input, textarea, select')
        : (t && /^(IMG|A|BUTTON|INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
      if (!interactive && e.cancelable !== false && typeof e.preventDefault === 'function') {
        e.preventDefault();
      }
      this._clearSelection();
      timer = setTimeout(() => {
        timer = null;
        this.open(msg, el, { x: startX, y: startY });
      }, LONG_PRESS_MS);
    };
    const onPointerMove = (e) => {
      if (timer === null) return;
      const dx = (e.clientX ?? 0) - startX;
      const dy = (e.clientY ?? 0) - startY;
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE_PX) clear();
    };
    const onContextMenu = (e) => {
      e.preventDefault();
      this.open(msg, el, { x: e.clientX ?? 0, y: e.clientY ?? 0 });
    };
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', clear);
    el.addEventListener('pointercancel', clear);
    el.addEventListener('contextmenu', onContextMenu);
    return () => {
      clear();
      el.removeEventListener?.('pointerdown', onPointerDown);
      el.removeEventListener?.('pointermove', onPointerMove);
      el.removeEventListener?.('pointerup', clear);
      el.removeEventListener?.('pointercancel', clear);
      el.removeEventListener?.('contextmenu', onContextMenu);
    };
  }

  /** 打开菜单。anchorRect 优先取气泡元素的 getBoundingClientRect()，
   *  拿不到时用传入的点坐标退化为 1×1 锚点。 */
  open(msg, anchorEl, point = {}) {
    this.close({ restoreScroll: false });
    // 打开前先清掉可能已出现的原生选区（真机上长按 500ms 内选区可能已起）。
    this._clearSelection();
    const doc = this.doc;
    const rect = this._anchorRect(anchorEl, point);
    const viewport = {
      width: this.win?.innerWidth || 390,
      height: this.win?.innerHeight || 844,
    };
    const bottomReserve = this._bottomReserve();
    const pos = computeMenuPlacement(rect, this.menuSize, viewport, {
      reactionBarHeight: this.reactionBarHeight,
      bottomReserve,
    });
    if (this.scrollContainer) this._savedScrollTop = this.scrollContainer.scrollTop || 0;

    const root = doc.createElement('div');
    root.className = 'lp-menu-root';
    const backdrop = doc.createElement('div');
    backdrop.className = 'lp-menu-backdrop';
    backdrop.addEventListener('click', () => this.close());
    root.appendChild(backdrop);

    const reactions = doc.createElement('div');
    reactions.className = 'lp-reaction-bar';
    reactions.style.top = `${pos.reactions.top}px`;
    reactions.style.left = `${pos.reactions.left}px`;
    for (const emoji of REACTION_EMOJIS) {
      const b = doc.createElement('button');
      b.className = 'lp-reaction' + (hasMyReaction(msg, emoji) ? ' active' : '');
      b.type = 'button';
      b.textContent = emoji;
      b.setAttribute('aria-label', `反应 ${emoji}`);
      b.addEventListener('click', () => {
        const next = toggleReaction(this._message || msg, emoji);
        this._message = next;
        b.classList.toggle('active', hasMyReaction(next, emoji));
        this.callbacks.onReact?.(next, emoji);
      });
      reactions.appendChild(b);
    }
    const more = doc.createElement('button');
    more.className = 'lp-reaction lp-reaction-more';
    more.type = 'button';
    more.textContent = '＋';
    more.setAttribute('aria-label', '更多反应');
    more.addEventListener('click', () => this.callbacks.onMoreReactions?.(this._message || msg));
    reactions.appendChild(more);
    root.appendChild(reactions);

    const menu = doc.createElement('div');
    menu.className = 'lp-menu';
    menu.setAttribute('role', 'menu');
    menu.style.top = `${pos.menu.top}px`;
    menu.style.left = `${pos.menu.left}px`;
    for (const item of getMenuItems(msg)) {
      menu.appendChild(this._menuButton(item, msg));
    }
    // 次级入口：单独一行“更多”，点开再展开上下文开关与查看原始内容。
    const moreRow = doc.createElement('button');
    moreRow.className = 'lp-menu-item lp-menu-more';
    moreRow.type = 'button';
    moreRow.textContent = '更多';
    moreRow.addEventListener('click', () => {
      if (menu.querySelector('.lp-menu-secondary')) return;
      const sec = doc.createElement('div');
      sec.className = 'lp-menu-secondary';
      for (const item of getSecondaryItems(msg)) {
        sec.appendChild(this._menuButton(item, msg));
      }
      menu.appendChild(sec);
      moreRow.remove();
    });
    menu.appendChild(moreRow);
    root.appendChild(menu);

    (doc.body || doc.documentElement).appendChild(root);
    this._root = root;
    this._message = msg;
    this._anchorEl = anchorEl || null;
    this._open = true;
    if (anchorEl?.classList) anchorEl.classList.add('lp-highlight');
    // 抑制原生 contextmenu 与整页默认选中菜单（touch-callout / user-select）。
    // CSS 层（styles.css B 组块）已在气泡与菜单上禁选；这里再加运行时防线：
    // 打开期间任何 selectionchange 都立即清掉，关菜单时解绑。
    const de = doc.documentElement;
    if (de?.style) {
      this._savedUserSelect = de.style.userSelect || '';
      this._savedTouchCallout = de.style.webkitTouchCallout || '';
      de.style.userSelect = 'none';
      de.style.webkitTouchCallout = 'none';
    }
    doc.addEventListener?.('selectionchange', this._boundSelectionChange);
    doc.addEventListener?.('pointerdown', this._boundDocClick, true);
    doc.addEventListener?.('contextmenu', this._boundDocContextMenu);
    doc.addEventListener?.('keydown', this._boundKeyDown);
    return pos;
  }

  /** 关闭菜单；默认恢复打开前记录的滚动位置。 */
  close(opts = {}) {
    const restoreScroll = opts.restoreScroll !== false;
    if (!this._open && !this._root) return;
    if (this._root?.remove) this._root.remove();
    else if (this._root?.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;
    this._open = false;
    if (this._anchorEl?.classList) this._anchorEl.classList.remove('lp-highlight');
    this._anchorEl = null;
    const de = this.doc.documentElement;
    if (de?.style) {
      de.style.userSelect = this._savedUserSelect;
      de.style.webkitTouchCallout = this._savedTouchCallout;
    }
    this.doc.removeEventListener?.('pointerdown', this._boundDocClick, true);
    this.doc.removeEventListener?.('contextmenu', this._boundDocContextMenu);
    this.doc.removeEventListener?.('keydown', this._boundKeyDown);
    this.doc.removeEventListener?.('selectionchange', this._boundSelectionChange);
    if (restoreScroll && this.scrollContainer) {
      this.scrollContainer.scrollTop = this._savedScrollTop;
    }
    this._message = null;
  }

  destroy() {
    this.close({ restoreScroll: false });
  }

  _menuButton(item, msg) {
    const b = this.doc.createElement('button');
    b.className = 'lp-menu-item' + (item.danger ? ' danger' : '');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    const label = this.doc.createElement('span');
    label.className = 'lp-menu-label';
    label.textContent = item.label;
    b.appendChild(label);
    if (item.icon) {
      const svg = this.doc.createElementNS
        ? this.doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
        : this.doc.createElement('svg');
      svg.setAttribute('class', 'icon lp-menu-icon');
      const use = this.doc.createElementNS
        ? this.doc.createElementNS('http://www.w3.org/2000/svg', 'use')
        : this.doc.createElement('use');
      use.setAttribute('href', `#${item.icon}`);
      svg.appendChild(use);
      b.appendChild(svg);
    }
    b.addEventListener('click', () => this._invoke(item.id, msg));
    return b;
  }

  _invoke(id, msg) {
    const cb = this.callbacks;
    const m = this._message || msg;
    switch (id) {
      case 'copy': cb.onCopy?.(m); break;
      case 'quote': cb.onQuote?.(m); break;
      case 'favorite': cb.onFavorite?.(m); break;
      case 'select': cb.onSelect?.(m); break;
      case 'edit': cb.onEdit?.(m); break;
      case 'recall': cb.onRecall?.(m); break;
      case 'regenerate': cb.onRegenerate?.(m); break;
      case 'toggleContext': cb.onToggleContext?.(m); break;
      case 'viewRaw': cb.onViewRaw?.(m); break;
      case 'delete': {
        const token = createDeleteToken(m);
        cb.onDelete?.(m, token);
        break;
      }
      default: break;
    }
    // 删除也先关菜单：撤销入口在 toast 里，不在菜单里。
    this.close();
  }

  /** 清掉当前原生选区（无选区 API 的环境直接跳过，不抛错）。 */
  _clearSelection() {
    try {
      const sel = this.win?.getSelection?.()
        || (typeof globalThis.getSelection === 'function' ? globalThis.getSelection() : null);
      sel?.removeAllRanges?.();
    } catch { /* ignore */ }
  }

  _onDocPointerDown(e) {
    // 点到菜单/反应条之外 → 关闭；点在内部不处理（按钮自己会处理）。
    if (!this._root) return;
    let node = e.target;
    while (node) {
      if (node === this._root) return;
      node = node.parentNode;
    }
    this.close();
  }

  _anchorRect(anchorEl, point) {
    if (anchorEl && typeof anchorEl.getBoundingClientRect === 'function') {
      const r = anchorEl.getBoundingClientRect();
      if (r && Number.isFinite(r.width) && Number.isFinite(r.height) && (r.width > 0 || r.height > 0)) {
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
      }
    }
    const x = point.x ?? 0;
    const y = point.y ?? 0;
    return { top: y, bottom: y, left: x, right: x, width: 0, height: 0 };
  }

  /** 底部避让高度：键盘弹起时宿主可注入 visualViewport 高度差；
   *  默认 0（集成轮在 app.js 里接 visualViewport / 输入区高度后传入）。 */
  _bottomReserve() {
    if (typeof this.callbacks.getBottomReserve === 'function') {
      const v = this.callbacks.getBottomReserve();
      if (Number.isFinite(v) && v > 0) return v;
    }
    return 0;
  }
}

// storage.js — 持久化（storageAdapter）。
// IndexedDB 分表保存：characters / worldBooks / stickers / journals / messages /
// attachments / statusTemplates / settings / unknown / experiences / keywordIndex /
// wakeScenes / wakeAlarms / wakeReceipts。
// 消息按记录增量写入，绝不每发一条就全量 JSON 覆写；localStorage 只放很小的偏好。
// schema 升级不清空数据库。Node 测试用 MemoryBackend 实现同一接口。

export const DB_NAME = 'uwu-chat-db';
export const DB_VERSION = 4;

/** B 组设置键（settings 表的 key）：通知 / 音频保活 / 推送 / 自定义图标 / 唤醒。 */
export const B_GROUP_SETTINGS_KEYS = ['notifySettings', 'audioKeepAlive', 'pushSettings', 'customIcon', 'wakeSettings'];
/** B 组未读计数键（settings 表的 key，值 { charId: count }，见 inAppNotify.js）。 */
export const NOTIFY_UNREAD_SETTINGS_KEY = 'notifyUnread';
export const PAGE_SIZE = 50;

/** 内存后端：与 IDB 后端同一接口，供 Node 测试与 3 万条合成验证使用。 */
export class MemoryBackend {
  constructor() {
    this.tables = {
      characters: new Map(), worldBooks: new Map(), stickers: new Map(),
      journals: new Map(), messages: new Map(), attachments: new Map(),
      statusTemplates: new Map(), settings: new Map(), unknown: new Map(),
      vectorChunks: new Map(), experiences: new Map(), keywordIndex: new Map(),
      wakeScenes: new Map(), wakeAlarms: new Map(), wakeReceipts: new Map(),
    };
    this.msgOrder = []; // {id, charId, timestamp} 按写入顺序
  }
  async init() { return this; }
  async put(table, value) {
    const key = value.id ?? value.key ?? value.wakeId; // wakeReceipts 以 wakeId 为键
    this.tables[table].set(key, structuredClone(value));
    if (table === 'messages') this.msgOrder.push({ id: value.id, charId: value.charId, timestamp: value.timestamp });
    return key;
  }
  async putMany(table, values) {
    for (const v of values) await this.put(table, v);
  }
  async get(table, key) {
    const v = this.tables[table].get(key);
    return v === undefined ? null : structuredClone(v);
  }
  async getAll(table) {
    return [...this.tables[table].values()].map((v) => structuredClone(v));
  }
  async delete(table, key) {
    if (table === 'messages') this.msgOrder = this.msgOrder.filter((m) => m.id !== key);
    return this.tables[table].delete(key);
  }
  async clear(table) {
    this.tables[table].clear();
    if (table === 'messages') this.msgOrder = [];
  }
  async countMessages(charId) {
    return this.msgOrder.filter((m) => m.charId === charId).length;
  }
  async getMessagesPage(charId, { before = Infinity, limit = PAGE_SIZE } = {}) {
    const rows = this.msgOrder
      .filter((m) => m.charId === charId && m.timestamp < before)
      .sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
    const page = rows.slice(-limit);
    const out = [];
    for (const r of page) {
      const m = await this.get('messages', r.id);
      if (m) out.push(m);
    }
    return { messages: out, hasMore: rows.length > limit, oldestTimestamp: page[0]?.timestamp ?? null };
  }
  async getAllMessages(charId) {
    const { messages } = await this.getMessagesPage(charId, { before: Infinity, limit: Number.MAX_SAFE_INTEGER });
    return messages;
  }
  /** 只取当前角色 + 当前索引空间的向量段（不加载全库）。 */
  async getVectorChunks(charId, spaceKey) {
    return [...this.tables.vectorChunks.values()]
      .filter((c) => c.charId === charId && c.spaceKey === spaceKey)
      .map((v) => structuredClone(v));
  }
}

/**
 * v1→v2 迁移：只新增 vectorChunks 表（keyPath id，索引 byCharSpace / byJournal），
 * 绝不重建、不清空已有表；老库（只有 journals 等旧表）升级后旧数据原样保留。
 * 导出供测试用假 db 验证迁移逻辑；IDBBackend.open 的 onupgradeneeded 也走它。
 */
export function ensureVectorStores(db) {
  if (!db.objectStoreNames.contains('vectorChunks')) {
    const s = db.createObjectStore('vectorChunks', { keyPath: 'id' });
    if (typeof s.createIndex === 'function') {
      s.createIndex('byCharSpace', ['charId', 'spaceKey'], { unique: false });
      s.createIndex('byJournal', 'journalId', { unique: false });
    }
  }
  return db;
}

/**
 * v2→v3 迁移：只新增 experiences 表（keyPath id，索引 byChar [charId, timestamp]）
 * 与 keywordIndex 空表（keyPath id，索引 byChar [charId, term]），绝不重建、
 * 不清空已有表；老库升级后旧数据原样保留。本波只建表不写数据：
 * experiences 由经历提取写入，keywordIndex 的倒排数据由第 2 波写入。
 * 导出供测试用假 db 验证迁移逻辑；IDBBackend.open 的 onupgradeneeded 也走它。
 */
export function ensureExperienceStores(db) {
  if (!db.objectStoreNames.contains('experiences')) {
    const s = db.createObjectStore('experiences', { keyPath: 'id' });
    if (typeof s.createIndex === 'function') {
      s.createIndex('byChar', ['charId', 'timestamp'], { unique: false });
    }
  }
  if (!db.objectStoreNames.contains('keywordIndex')) {
    const s = db.createObjectStore('keywordIndex', { keyPath: 'id' });
    if (typeof s.createIndex === 'function') {
      s.createIndex('byChar', ['charId', 'term'], { unique: false });
    }
  }
  return db;
}

/**
 * v3→v4 迁移：只新增 wakeScenes / wakeAlarms / wakeReceipts 三张表（与
 * js/wakeEngine.js 的 ensureWakeStores 同一建表逻辑，本函数是 storage.js
 * 内的独立实现，不 import wakeEngine，避免循环依赖），绝不重建、不清空
 * 已有表；老库升级后旧数据原样保留。wakeReceipts 以 wakeId 为 keyPath。
 * 导出供测试用假 db 验证迁移逻辑；IDBBackend.open 的 onupgradeneeded 也走它。
 */
export function ensureWakeStores(db) {
  if (!db.objectStoreNames.contains('wakeScenes')) {
    const s = db.createObjectStore('wakeScenes', { keyPath: 'id' });
    if (typeof s.createIndex === 'function') {
      s.createIndex('byChar', ['charId', 'nextAt'], { unique: false });
      s.createIndex('byStatus', ['status', 'nextAt'], { unique: false });
    }
  }
  if (!db.objectStoreNames.contains('wakeAlarms')) {
    const s = db.createObjectStore('wakeAlarms', { keyPath: 'id' });
    if (typeof s.createIndex === 'function') s.createIndex('byChar', ['charId', 'at'], { unique: false });
  }
  if (!db.objectStoreNames.contains('wakeReceipts')) db.createObjectStore('wakeReceipts', { keyPath: 'wakeId' });
  return db;
}

/** 浏览器 IndexedDB 后端。 */
export class IDBBackend {
  constructor(dbName = DB_NAME) { this.dbName = dbName; this.db = null; }
  async init() { return this.open(); }
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('characters')) db.createObjectStore('characters', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('worldBooks')) db.createObjectStore('worldBooks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('stickers')) db.createObjectStore('stickers', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('journals')) db.createObjectStore('journals', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('messages')) {
          const s = db.createObjectStore('messages', { keyPath: 'id' });
          s.createIndex('byChar', ['charId', 'timestamp'], { unique: false });
        }
        if (!db.objectStoreNames.contains('attachments')) db.createObjectStore('attachments', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('statusTemplates')) db.createObjectStore('statusTemplates', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('unknown')) db.createObjectStore('unknown', { keyPath: 'key' });
        ensureVectorStores(db);
        ensureExperienceStores(db);
        ensureWakeStores(db);
      };
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  }
  tx(table, mode, fn) {
    return this.open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(table, mode);
      const store = t.objectStore(table);
      const out = fn(store);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    }));
  }
  async put(table, value) { await this.tx(table, 'readwrite', (s) => s.put(structuredClone(value))); return value.id ?? value.key ?? value.wakeId; }
  async putMany(table, values) {
    await this.tx(table, 'readwrite', (s) => { for (const v of values) s.put(structuredClone(v)); });
  }
  async get(table, key) {
    return this.open().then((db) => new Promise((resolve, reject) => {
      const req = db.transaction(table, 'readonly').objectStore(table).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    }));
  }
  async getAll(table) {
    return this.open().then((db) => new Promise((resolve, reject) => {
      const req = db.transaction(table, 'readonly').objectStore(table).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }
  async delete(table, key) { await this.tx(table, 'readwrite', (s) => s.delete(key)); }
  async clear(table) { await this.tx(table, 'readwrite', (s) => s.clear()); }
  /** 只取当前角色 + 当前索引空间的向量段（走 byCharSpace 索引，不加载全库）。 */
  async getVectorChunks(charId, spaceKey) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const idx = db.transaction('vectorChunks', 'readonly').objectStore('vectorChunks').index('byCharSpace');
      const req = idx.getAll(IDBKeyRange.only([charId, spaceKey]));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  async countMessages(charId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const idx = db.transaction('messages', 'readonly').objectStore('messages').index('byChar');
      const req = idx.count(IDBKeyRange.bound([charId, -Infinity], [charId, Infinity]));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async getMessagesPage(charId, { before = Infinity, limit = PAGE_SIZE } = {}) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const idx = db.transaction('messages', 'readonly').objectStore('messages').index('byChar');
      const range = IDBKeyRange.bound([charId, -Infinity], [charId, before === Infinity ? Infinity : before - 1]);
      const req = idx.openCursor(range, 'prev');
      const rows = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor && rows.length < limit) { rows.push(cursor.value); cursor.continue(); }
        else {
          rows.reverse();
          const hasMore = !!cursor;
          resolve({ messages: rows, hasMore, oldestTimestamp: rows[0]?.timestamp ?? null });
        }
      };
      req.onerror = () => reject(req.error);
    });
  }
  async getAllMessages(charId) {
    const all = [];
    let before = Infinity;
    for (;;) {
      const { messages, hasMore } = await this.getMessagesPage(charId, { before, limit: 1000 });
      if (!messages.length) break;
      all.unshift(...messages);
      if (!hasMore) break;
      before = messages[0].timestamp;
      if (all.length > 200000) break; // 安全上限
    }
    return all;
  }
}

/** 状态模板去重：同一 {regexPattern, replacePattern} 只存一份实体。 */
export function templateIdFor(panel) {
  if (!panel?.regexPattern && !panel?.replacePattern) return null;
  let h = 5381;
  const s = `${panel.regexPattern || ''}\n${panel.replacePattern || ''}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `tpl_${h.toString(36)}`;
}

export async function saveStatusTemplate(backend, panel) {
  const id = templateIdFor(panel);
  if (!id) return null;
  const existing = await backend.get('statusTemplates', id);
  const version = (existing?.version || 0) + (existing ? 0 : 1);
  await backend.put('statusTemplates', {
    id, version,
    regexPattern: panel.regexPattern || '',
    replacePattern: panel.replacePattern || '',
    promptSuffix: panel.promptSuffix || '',
    updatedAt: Date.now(),
  });
  return { id, version };
}

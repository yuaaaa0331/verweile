// utils.js — 环境无关的小工具（浏览器与 Node 测试共用）
export const pad = (n) => String(n).padStart(2, '0');

export function uid(prefix = 'msg') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/** 设备本地时间（用户时区），格式：2026年11月19日 23:42。不硬编码服务器时间。 */
export function nowTimeString(date = new Date()) {
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatTimeDivider(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const timeStr = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (isToday) return timeStr;
  if (isYesterday) return `昨天 ${timeStr}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${timeStr}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${timeStr}`;
}

export function formatTimeGap(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}天${h % 24}小时`;
  if (h > 0) return `${h}小时${m % 60}分钟`;
  if (m > 0) return `${m}分钟`;
  return `${s}秒`;
}

/** UWU 原 countTextTokens：中文 1.2 / 其他 0.4，估算值。调用方必须标注“估算”。 */
export function countTextTokens(text) {
  if (!text) return 0;
  const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const other = text.length - chinese;
  return Math.ceil(chinese * 1.2 + other * 0.4);
}

/** maxMemory 可能是字符串 '80'：转换并校验，无效时回落 80。 */
export function parseMaxMemory(value, fallback = 80) {
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(500, Math.floor(n));
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 简单稳定的字符串哈希（用于状态模板去重、缺 ID 记录的稳定识别）。 */
export function hashString(s) {
  let h = 5381;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 从多个逗号分隔的 Key 中随机取一个（UWU 原 getRandomValue）。 */
export function pickKey(str) {
  if (str && String(str).includes(',')) {
    const arr = String(str).split(',').map((x) => x.trim()).filter(Boolean);
    return arr[Math.floor(Math.random() * arr.length)];
  }
  return str;
}

export function friendlyErrorMessage(error) {
  if (!error) return '发生了未知错误。';
  if (error.name === 'AbortError' || error.message === 'aborted') return '已停止生成。';
  const status = error.status ?? error.response?.status;
  if (status) {
    switch (status) {
      case 400: return '请求参数有误 (400)，通常是模型名不对或发送内容过长。';
      case 401: return 'API 密钥无效 (401)，请检查 API 设置中的 Key。';
      case 403: return '访问被拒绝 (403)，可能是密钥权限不足。';
      case 404: return 'API 地址错误 (404)，请检查 Base URL。';
      case 429: return '请求太频繁 (429)，触发了速率限制，请稍等再试。';
      case 500: return '服务器内部错误 (500)，服务商那边出问题了。';
      case 502: return '网关错误 (502)，服务商网络异常。';
      case 503: return '服务暂时不可用 (503)，可能正在维护或过载。';
      case 504: return '网关超时 (504)，服务器响应太慢。';
      default: return `服务器返回错误 (状态码 ${status})，请稍后再试。`;
    }
  }
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(error.message || '')) {
    return '无法连接到服务器，请检查网络或 API 地址。';
  }
  if (/HTML|<!doctype|<html/i.test(error.message || '')) {
    return 'API 返回了网页 HTML 而不是 JSON，请检查 Base URL 是否正确。';
  }
  return error.message || '发生了未知错误。';
}

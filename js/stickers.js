// stickers.js — 表情包取图与筛选的纯函数（与界面、存储分离，可单测）。
// 原版 UWU 的贴纸记录格式是 { id, name, group, data: <http(s) 图片 URL>, lastUsedTime }，
// 渲染用 data 作 img src；verweile 自己的记录用 dataUrl / attachmentId。
// 取图优先级：dataUrl > attachmentId > data，三者都没有返回 null。

export const STICKER_PAGE_SIZE = 60;
export const UNCATEGORIZED = '未分类';

/**
 * 返回表情包的图片来源描述：
 * - { kind: 'url', src }：可直接作 <img src>（dataUrl 或原版 data 字段，远程 URL / data: URL）
 * - { kind: 'attachment', id }：需经 attachmentDataURL 解析
 * - null：没有任何图片来源
 */
export function stickerImageSrc(st) {
  if (!st || typeof st !== 'object') return null;
  if (typeof st.dataUrl === 'string' && st.dataUrl) return { kind: 'url', src: st.dataUrl };
  if (typeof st.attachmentId === 'string' && st.attachmentId) return { kind: 'attachment', id: st.attachmentId };
  if (typeof st.data === 'string' && st.data) return { kind: 'url', src: st.data };
  return null;
}

/** 归一化分组名：缺 group / 空白都归入「未分类」。 */
export function stickerGroupOf(st) {
  const g = typeof st?.group === 'string' ? st.group.trim() : '';
  return g || UNCATEGORIZED;
}

/** 按首次出现顺序返回全部分组（含未分类组）。 */
export function stickerGroupsOf(stickers = []) {
  const out = [];
  for (const st of stickers || []) {
    const g = stickerGroupOf(st);
    if (!out.includes(g)) out.push(g);
  }
  return out;
}

/**
 * 已知表情包名称：原版 UWU 的兜底规则（chat_render.js：先按角色分组找，
 * 找不到再按名字在全库找）。渲染/解析只认“库里有没有这个名字”——分组只
 * 决定提示词里列哪些（见 promptBuilder.collectStickerNames），不决定一张
 * 真实存在的表情包能不能显示。否则角色 stickerGroups 为空时，所有已导入
 * 的表情包都会被当成未知名称，只能看到协议文字。
 * 返回顺序：分组内的名字在前（库内顺序），其余库内名字在后，均去重。
 */
export function knownStickerNames(stickers = [], groups = '') {
  const names = [];
  const seen = new Set();
  const gs = String(groups || '').split(/[,，]/).map((s) => s.trim()).filter((s) => s && s !== UNCATEGORIZED);
  for (const st of stickers || []) {
    if (st?.name && gs.includes(stickerGroupOf(st)) && !seen.has(st.name)) { seen.add(st.name); names.push(st.name); }
  }
  for (const st of stickers || []) {
    if (st?.name && !seen.has(st.name)) { seen.add(st.name); names.push(st.name); }
  }
  return names;
}

/**
 * 按分组 + 名称搜索过滤。group 为 '全部'（或空）时不过滤分组；
 * query 为空时不过滤名称；名称匹配不区分大小写、去首尾空白。
 */
export function filterStickers(stickers = [], { group = '', query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return (stickers || []).filter((st) => {
    if (group && group !== '全部' && stickerGroupOf(st) !== group) return false;
    if (q && !String(st?.name || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

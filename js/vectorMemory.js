// vectorMemory.js — 向量记忆的纯逻辑（vectorMemory）。
// 分段、哈希、索引空间键、余弦相似度、检索排序去重、查询文本组装，
// 以及后端无关的索引编排（建索引 / 补齐 / 重建 / 取消 / 进度）。
// 向量只来自文字→embedding 的真实接口调用（app.js 里调 auxApi.callEmbeddings），
// 本文件绝不伪造向量、不调网络、不碰 DOM；IndexedDB 的具体读写走
// storage.js 的 backend（getAll / put / delete / getVectorChunks）。
// 记忆原文永远保留在 journals 表；vectorChunks 只是可重建的缓存，
// 恢复备份后按 journals 重新建索引即可。
import { countTextTokens } from './utils.js';
import { isExcludedFromSummary } from './memorySummary.js';
import { messageText, extractProtocolText } from './historyBuilder.js';
import { isExperienceValid, sourceStatusOfJournal } from './experiences.js';
import {
  searchKeyword, hasKeywordIndex, updateKeywordDoc, deleteKeywordDoc,
  buildKeywordIndex, normalizeRetrievalDoc, retrievalDocsForChar,
  retrievalDocRetrievable,
} from './keywordSearch.js';

/**
 * 向量记忆默认设置。
 * threshold 默认值 0.40 的实测依据（见 tests/vectorMemory.test.mjs 两组「阈值实测」）：
 * (1) 裸句对（桩向量，单字哈希 128 维归一化）：相关组余弦 0.546–0.857，
 * 不相关组 0.000–0.355，0.40 落在两者之间；
 * (2) 真实查询组装（最新发言 + 最近 2 轮对话拼成查询文本、索引侧用带标题+日期的
 * 分段文本，近乎原文的问句）：不加权时相关组最低只有 0.342，单降阈值到 0.40 仍
 * 召回不了；最新发言在查询文本里重复一次加权后，相关组 0.436–0.664，种子句
 * 「我们上周去海边约好下周再去吗？」对记忆段 0.561，0.40 能稳定召回。
 * 不相关组在桩向量下个别虚高到 0.485，经复核是单字哈希 128 维的碰撞噪声
 * （无碰撞的字面余弦最高仅 0.127），不是真实相似；真实模型的相似度分布与桩
 * 不同，所以阈值必须在记忆页可调；换模型后建议先用「测试召回」校准再定。
 */
export const DEFAULT_VECTOR_SETTINGS = {
  enabled: true,
  topK: 5,
  threshold: 0.40,
  tokenBudget: 1500,
  dimensions: 0,
  dimensionsFor: '',
};

export const VECTOR_CHUNK_MAX = 600; // 每段正文最多 600 字
export const VECTOR_CHUNK_OVERLAP = 80; // 相邻段重叠约 80 字
export const VECTOR_INDEX_BATCH = 20; // 每批 20 条
export const VECTOR_INDEX_CONCURRENCY = 2; // 批内并发 2

/** FNV-1a 32 位确定性哈希（十六进制）：同内容同哈希，改一字即变。 */
export function fnv1aHex(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function formatMemoryDate(ts) {
  const d = new Date(ts || 0);
  if (Number.isNaN(d.getTime()) || !ts) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 记忆正文切段：每段正文 ≤600 字、重叠约 80 字，每段前附标题+日期作上下文。 */
export function chunkMemoryText({ title = '', content = '', timestamp = 0 } = {}) {
  const body = String(content || '').trim();
  if (!body) return [];
  const date = formatMemoryDate(timestamp);
  const header = [title ? `标题：${title}` : '', date ? `日期：${date}` : '']
    .filter(Boolean).join('\n');
  const chunks = [];
  let start = 0;
  let index = 0;
  while (start < body.length) {
    const end = Math.min(start + VECTOR_CHUNK_MAX, body.length);
    const slice = body.slice(start, end);
    const text = header ? `${header}\n${slice}` : slice;
    chunks.push({ index, text, body: slice, hash: fnv1aHex(slice) });
    if (end >= body.length) break;
    start = end - VECTOR_CHUNK_OVERLAP;
    index++;
  }
  return chunks;
}

/** 归一化 baseUrl：去尾斜杠、去 /v1 与 /chat/completions 后缀（与 auxApi.resolveBase 同规则）。 */
export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().toLowerCase()
    .replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/v1$/, '');
}

/**
 * 索引空间键 = 归一化 baseUrl + 模型 + 维度。
 * 维度相同但模型不同也绝不能混用；baseUrl 不同、模型不同、维度不同都换空间。
 */
export function spaceKeyFor({ baseUrl = '', model = '', dimensions = 0 } = {}) {
  return `${normalizeBaseUrl(baseUrl)}|${String(model || '').trim().toLowerCase()}|${Number(dimensions) || 0}`;
}

/** 余弦相似度：相同向量 1、相反 -1、正交 0；零向量返回 0。 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 检索排序去重：按余弦从高到低，低于阈值的不要；同一记忆 ID 只留分数最高的一段；
 * 默认最多召回 topK 条。entries: [{ journalId, vector, ... }]。
 */
export function rankCandidates(queryVector, entries, { topK = 5, threshold = 0.40 } = {}) {
  const scored = [];
  for (const e of entries || []) {
    if (!e?.vector) continue;
    const score = cosineSimilarity(queryVector, e.vector);
    if (score < threshold) continue;
    scored.push({ ...e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    if (seen.has(s.journalId)) continue;
    seen.add(s.journalId);
    out.push(s);
    if (out.length >= Math.max(1, topK)) break;
  }
  return out;
}

/** 召回结果去掉已固定注入的收藏记忆（按记忆 ID），同一条不要出现两次。 */
export function dedupeAgainstFavorited(retrieved, favoritedIds) {
  const fav = new Set(favoritedIds || []);
  return (retrieved || []).filter((r) => !fav.has(r.journalId));
}

/**
 * 记忆 Token 预算：按排名顺序取，累计估算 Token 超出预算的跳过；
 * 但至少保留排名第一的一条（超出时截断其内容以贴合预算）。
 */
export function applyTokenBudget(items, tokenBudget, countTokens = countTextTokens) {
  const budget = Number(tokenBudget) || 0;
  if (!budget || !items?.length) return items || [];
  const out = [];
  let used = 0;
  for (const item of items) {
    const text = item.content || item.body || item.text || '';
    const tokens = countTokens(text);
    if (out.length && used + tokens > budget) continue;
    if (!out.length && tokens > budget) {
      // 首条也超预算：按字符粗截到预算内（中文约 1.2 token/字）。
      const keepChars = Math.max(40, Math.floor(budget / 1.2));
      out.push({ ...item, content: String(text).slice(0, keepChars), truncated: true });
      used = budget;
      continue;
    }
    out.push(item);
    used += tokens;
  }
  return out;
}

/**
 * 检索查询文本：最新用户发言 + 最近 2 轮对话文本拼在一起，
 * 「那次」「那里」这类指代靠最近对话的文本本身消解，不做额外改写。
 * 最新发言在查询里出现两次（加权）：只拼最近对话会稀释余弦——实测近乎原文的
 * 问句对记忆段最低只有 0.342，低于阈值；重复一次最新发言后升到 0.436，
 * 种子句 0.561，近乎原文的查询才能稳定召回（见测试「阈值实测（真实查询组装）」）。
 * 没有最近对话时只返回最新发言，不重复。
 */
export function buildRetrievalQueryText(latestUserText, recentTexts = []) {
  const latest = String(latestUserText || '').trim();
  const recent = (recentTexts || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!recent.length) return latest;
  return `最近对话：${recent.join(' / ')}\n最新发言：${latest}\n最新发言：${latest}`;
}

/** 召回结果转成进提示词的可读文字（带标题、日期、来源；发给主模型的是文字，不是向量）。 */
export function formatRetrievedForPrompt(items) {
  return (items || []).map((m) => [
    m.title ? `标题：${m.title}` : '',
    m.date ? `日期：${m.date}` : '',
    m.source ? `来源：${m.source}` : '',
    `内容：${m.content || m.body || ''}`,
  ].filter(Boolean).join('\n')).join('\n\n---\n\n');
}

/** 文档种类：显式 kind/docKind 优先；原始经历对象没有 kind 字段时按形状识别
 *（有 quotes 或 summary 即经历，与 keywordSearch.normalizeRetrievalDoc 同一规则）。 */
export function docKindOf(doc) {
  return doc?.docKind || doc?.kind
    || (Array.isArray(doc?.quotes) || typeof doc?.summary === 'string' ? 'experience' : 'journal');
}

/**
 * 检索文档的向量正文：记忆是 content；经历是关键细节 + 关键原话。
 * 与 keywordSearch.experienceContent 同一规则（标题由 chunkMemoryText 的
 * header 另行附上，这里只给正文）。
 */
export function documentContent(doc) {
  const kind = docKindOf(doc);
  if (kind === 'experience') {
    const quotes = (doc?.quotes || []).map((q) => q?.text || '').filter(Boolean);
    return [doc?.summary || '', ...quotes].filter(Boolean).join('\n');
  }
  return String(doc?.content || '');
}

/** 一条检索文档（记忆或经历）的全部待索引分段记录（不含向量；向量由调用方填）。 */
export function buildDocumentChunkRecords(doc, charId, spaceKey) {
  const kind = docKindOf(doc);
  const chunks = chunkMemoryText({
    title: doc?.title || '',
    content: documentContent(doc),
    timestamp: doc?.timestamp || doc?.createdAt || 0,
  });
  return chunks.map((c) => ({
    id: `${doc.id}:c${c.index}`,
    journalId: doc.id,
    kind,
    charId,
    spaceKey,
    chunkIndex: c.index,
    text: c.text,
    body: c.body,
    hash: c.hash,
    title: doc?.title || '',
    source: doc?.source || (kind === 'experience' ? '经历提取' : '手动记录'),
    timestamp: doc?.timestamp || doc?.createdAt || 0,
    date: formatMemoryDate(doc?.timestamp || doc?.createdAt || 0),
  }));
}

/** 一条记忆的全部待索引分段记录（不含向量；向量由调用方填）。 */
export function buildChunkRecords(journal, charId, spaceKey, kind = 'journal') {
  return buildDocumentChunkRecords({ ...journal, kind }, charId, spaceKey);
}

/** 一条经历的全部待索引分段记录：复用同一 chunk 结构，journalId 存经历 id，kind='experience'。 */
export function buildExperienceChunkRecords(exp, charId, spaceKey) {
  return buildDocumentChunkRecords({ ...exp, kind: 'experience' }, charId, spaceKey);
}

/** 记忆是否参与检索：retrievalEnabled 缺省（老数据）视为 true。 */
export function journalRetrievable(journal) {
  return journal?.retrievalEnabled !== false;
}

/** 检索文档是否参与检索：记忆看 retrievalEnabled；经历还要有效（未失效）。 */
export function documentRetrievable(doc) {
  const kind = docKindOf(doc);
  if (doc?.retrievalEnabled === false) return false;
  // 归一化后的文档用 valid 字段表示有效性（无 status 字段时以它为准）。
  if (kind === 'experience') return doc?.valid !== false && isExperienceValid(doc);
  return true;
}

/** 检索文档的原文出处状态：记忆按 sourceStatusOfJournal；经历有来源消息即 sourced。 */
export function documentSourceStatus(doc) {
  const kind = docKindOf(doc);
  if (kind === 'experience') {
    const ids = doc?.sourceMessageIds?.length
      ? doc.sourceMessageIds
      : (doc?.quotes || []).map((q) => q?.messageId).filter(Boolean);
    return ids.length ? 'sourced' : 'unsourced';
  }
  return sourceStatusOfJournal(doc);
}

/** 读当前角色+当前空间的索引（只加载这部分，不加载全库）。 */
export async function getChunksForSpace(backend, charId, spaceKey) {
  if (typeof backend.getVectorChunks === 'function') {
    return backend.getVectorChunks(charId, spaceKey) || [];
  }
  const all = await backend.getAll('vectorChunks');
  return all.filter((c) => c.charId === charId && c.spaceKey === spaceKey);
}

/** 当前角色各索引空间的条数（记忆页显示用）。 */
export async function getIndexSpaces(backend, charId) {
  const all = (await backend.getAll('vectorChunks')).filter((c) => c.charId === charId);
  const bySpace = new Map();
  for (const c of all) bySpace.set(c.spaceKey, (bySpace.get(c.spaceKey) || 0) + 1);
  return [...bySpace.entries()].map(([spaceKey, count]) => ({ spaceKey, count }))
    .sort((a, b) => b.count - a.count);
}

/** 索引状态：每条文档已索引几段、缺失几段；恢复备份后这里显示真实状态，不造假。 */
export async function getIndexStatus(backend, charId, journals, spaceKey) {
  const existing = await getChunksForSpace(backend, charId, spaceKey);
  const byJournal = new Map();
  for (const c of existing) {
    if (!byJournal.has(c.journalId)) byJournal.set(c.journalId, []);
    byJournal.get(c.journalId).push(c);
  }
  const perJournal = [];
  let totalChunks = 0, indexedChunks = 0;
  for (const j of journals || []) {
    if (!documentRetrievable(j)) continue;
    const want = buildDocumentChunkRecords(j, charId, spaceKey);
    totalChunks += want.length;
    const have = byJournal.get(j.id) || [];
    const ok = want.filter((w) => have.some((h) => h.chunkIndex === w.chunkIndex && h.hash === w.hash)).length;
    indexedChunks += ok;
    perJournal.push({
      journalId: j.id, docKind: docKindOf(j), title: j.title,
      wanted: want.length, indexed: ok, missing: want.length - ok,
    });
  }
  const spaces = await getIndexSpaces(backend, charId);
  return { spaceKey, totalChunks, indexedChunks, missing: totalChunks - indexedChunks, perJournal, spaces };
}

/** 删除一条文档（记忆或经历）的全部索引段（编辑/删除时调用）。 */
export async function deleteJournalIndex(backend, journalId) {
  const all = await backend.getAll('vectorChunks');
  let n = 0;
  for (const c of all.filter((x) => x.journalId === journalId)) {
    await backend.delete('vectorChunks', c.id);
    n++;
  }
  return n;
}

/** deleteJournalIndex 的通用名：chunk 的 journalId 字段存的就是文档 id，两种文档通用。 */
export const deleteDocumentIndex = deleteJournalIndex;

/** 删除当前角色在指定空间的全部索引（重建用）。 */
export async function deleteSpaceIndex(backend, charId, spaceKey) {
  const list = await getChunksForSpace(backend, charId, spaceKey);
  for (const c of list) await backend.delete('vectorChunks', c.id);
  return list.length;
}

/**
 * 建索引 / 补齐缺失（通用：记忆 + 经历）：只对参与检索的文档分段；内容未变
 * （哈希相同）复用已有向量，不重复调接口；大任务分批（每批 20 条、批内并发 2），
 * 失败重试一次；每批完成后保存进度（saveProgress），刷新后按已保存进度继续；
 * signal.cancelled 为真时在批间停下（暂停），已保存的段不丢失。
 * embedTexts(texts) => { vectors, dimensions }，由调用方接真实向量接口。
 * documents 里的条目用 kind/docKind 区分（'journal' | 'experience'，缺省 journal）；
 * 老 chunk 缺 kind 字段时视为 journal。
 */
export async function indexDocuments({
  backend, charId, documents, spaceKey,
  embedTexts, onProgress, saveProgress, signal,
  batchSize = VECTOR_INDEX_BATCH, concurrency = VECTOR_INDEX_CONCURRENCY,
} = {}) {
  const eligible = (documents || []).filter(documentRetrievable);
  const existing = await getChunksForSpace(backend, charId, spaceKey);
  const existingById = new Map(existing.map((c) => [c.id, c]));
  const wanted = eligible.flatMap((j) => buildDocumentChunkRecords(j, charId, spaceKey));
  // 内容已变或维度对不上的旧段先清掉（旧段的 hash 不一致即视为过期）。
  // 清理范围是本次传入的全部文档（不只是仍参与检索的）：某条文档改成
  // 不参与检索 / 失效后，它的旧段也要在这次重建里清掉，否则会继续被召回。
  // 没传入的文档的旧段绝不动：单条文档重建时绝不能误删其他文档的索引。
  const passedIds = new Set((documents || []).map((j) => j.id));
  for (const old of existing) {
    if (!passedIds.has(old.journalId)) continue;
    const w = wanted.find((x) => x.id === old.id);
    if (!w || w.hash !== old.hash) await backend.delete('vectorChunks', old.id);
  }
  const toEmbed = wanted.filter((w) => {
    const old = existingById.get(w.id);
    return !old || old.hash !== w.hash;
  });
  const total = wanted.length;
  let done = total - toEmbed.length;
  const progress = { charId, spaceKey, done, total, status: 'running', updatedAt: Date.now() };
  const reportProgress = async () => {
    progress.done = done;
    progress.updatedAt = Date.now();
    onProgress?.({ ...progress });
    await saveProgress?.({ ...progress });
  };
  await reportProgress();
  let embedded = 0;
  let failed = 0;
  for (let i = 0; i < toEmbed.length; i += batchSize) {
    if (signal?.cancelled) {
      progress.status = 'paused';
      await reportProgress();
      return { ...progress, embedded, failed, cancelled: true };
    }
    const batch = toEmbed.slice(i, i + batchSize);
    // 批内并发 2：两个 worker 从队列里取段。
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
      while (cursor < batch.length) {
        const chunk = batch[cursor++];
        if (signal?.cancelled) return;
        let vectors = null;
        let dimensions = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await embedTexts([chunk.text]);
            vectors = res.vectors;
            dimensions = res.dimensions;
            break;
          } catch (e) {
            if (attempt === 1) throw e;
          }
        }
        if (!vectors?.[0]) throw new Error('向量接口没有返回向量');
        await backend.put('vectorChunks', { ...chunk, vector: vectors[0], dimensions });
        embedded++;
        done++;
      }
    });
    try {
      await Promise.all(workers);
    } catch (e) {
      failed += batch.length;
      progress.status = 'error';
      progress.error = e?.message || String(e);
      await reportProgress();
      throw e;
    }
    await reportProgress();
    // 每批之间让出主线程，手机不卡。
    await new Promise((r) => setTimeout(r, 0));
  }
  progress.status = toEmbed.length ? 'done' : 'done';
  progress.done = total;
  await reportProgress();
  return { ...progress, embedded, failed, cancelled: false };
}

/**
 * 建索引 / 补齐缺失（记忆版，旧签名保持兼容）：与 indexDocuments 同一逻辑，
 * 只是入参叫 journals。经历进索引请用 indexDocuments（documents 里带 kind）。
 */
export async function indexJournals(opts = {}) {
  const { journals, ...rest } = opts;
  return indexDocuments({ ...rest, documents: journals });
}

/**
 * 裸向量候选（供 RRF 融合用，不做 Token 预算、不去收藏、不截断）：
 * 只检索当前角色、当前空间、参与检索的文档；按余弦降序、同一文档只留
 * 分数最高的一段；返回前 topN（默认 20）并带 1 起始的 rank。
 * documentsById：Map<文档 id, 原始记忆/经历>，kind 决定可检索性与 sourceStatus。
 * 阈值只作用于向量路（默认 0.40 不变）。
 */
export async function retrieveVectorCandidates({
  backend, charId, spaceKey, queryVector,
  documentsById, topN = 20, threshold = 0.40,
} = {}) {
  const chunks = await getChunksForSpace(backend, charId, spaceKey);
  const eligible = chunks.filter((c) => {
    const d = documentsById?.get(c.journalId);
    return d && documentRetrievable(d);
  });
  const scored = [];
  for (let i = 0; i < eligible.length; i += 200) {
    const slice = eligible.slice(i, i + 200);
    for (const c of slice) {
      const score = cosineSimilarity(queryVector, c.vector);
      if (score >= threshold) scored.push({ ...c, score });
    }
    if (i + 200 < eligible.length) await new Promise((r) => setTimeout(r, 0));
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    if (seen.has(s.journalId)) continue;
    seen.add(s.journalId);
    const d = documentsById.get(s.journalId);
    out.push({
      docId: s.journalId,
      journalId: s.journalId,
      docKind: s.kind || docKindOf(d),
      chunkId: s.id,
      title: s.title,
      content: s.body || s.text,
      source: s.source,
      date: s.date,
      timestamp: s.timestamp,
      score: s.score,
      rank: out.length + 1,
      sourceStatus: documentSourceStatus(d),
      sourceMessageIds: d?.sourceMessageIds || (d?.quotes || []).map((q) => q?.messageId).filter(Boolean) || [],
    });
    if (out.length >= Math.max(1, topN)) break;
  }
  return out;
}

/**
 * 真正检索：只检索当前角色、当前空间、参与检索的记忆；
 * 相似度计算分片执行（每 200 条让出一次主线程），不一次卡住手机。
 * 返回已去重（固定注入除外）、已按 Token 预算截取的召回条目。
 * journalsById 也可换成 documentsById（记忆 + 经历）；返回条目除原有
 * journalId 字段外，另带 docId / docKind / sourceStatus 供融合层复用。
 */
export async function retrieveFromIndex({
  backend, charId, spaceKey, queryVector,
  journalsById, documentsById, topK = 5, threshold = 0.40, tokenBudget = 1500,
  favoritedIds = [], countTokens,
} = {}) {
  const byId = documentsById || journalsById;
  const picked = await retrieveVectorCandidates({
    backend, charId, spaceKey, queryVector, documentsById: byId, topN: topK, threshold,
  });
  const deduped = dedupeAgainstFavorited(picked, favoritedIds);
  return applyTokenBudget(deduped, tokenBudget, countTokens);
}

/* ---------------- RRF 融合 + 邻居补全（第 2 波） ---------------- */

export const RRF_K = 60;

/**
 * RRF 融合：只按排名融合，绝不直接混加不同量纲的分数。
 * score_fused = Σ 1/(k + rank)，k 默认 60；rank 1 起始，未提供 rank 时按列表顺序补。
 * 返回 Map<docId, {docId, score, keywordRank, vectorRank}>（未命中一路的 rank 为 null）。
 */
export function rrfFuse(keywordRanked = [], vectorRanked = [], k = RRF_K) {
  const map = new Map();
  const add = (list, key) => {
    (list || []).forEach((item, i) => {
      const docId = item?.docId || item?.journalId;
      if (!docId) return;
      const rank = Number.isFinite(item?.rank) ? item.rank : i + 1;
      const cur = map.get(docId) || { docId, score: 0, keywordRank: null, vectorRank: null };
      cur.score += 1 / (k + rank);
      cur[key] = rank;
      map.set(docId, cur);
    });
  };
  add(keywordRanked, 'keywordRank');
  add(vectorRanked, 'vectorRank');
  return map;
}

/**
 * 把消息按轮次分组（与 memorySummary.countRounds / roundStarts 同一轮定义：
 * 一轮 = 一次用户发言 + 对应完整 AI 回复；同一 roundId 的多气泡只算一轮）。
 * 排除：物理删除的天然不在（调用方只传现存消息）、isExcludedFromSummary
 * 排除的（状态/思考/不进上下文/撤回/<thinking> 开头/隐藏段/空内容）、
 * 以及 char.supersededRounds 快照里的消息（已被替换的上一轮）。
 * 返回 [{messages, roundId, hasAssistant}]，按时间顺序。
 */
export function groupMessagesIntoRounds(messages, character) {
  const superseded = new Set();
  for (const r of character?.supersededRounds || []) {
    for (const m of r?.messages || []) if (m?.id) superseded.add(m.id);
  }
  const rounds = [];
  let current = null;
  let pendingUser = false;
  let currentRoundId = null;
  for (const m of messages || []) {
    if (!m || superseded.has(m.id)) continue;
    if (isExcludedFromSummary(m, character)) continue;
    if (m.role === 'user') {
      if (!current || current.hasAssistant) {
        current = { messages: [], roundId: null, hasAssistant: false };
        rounds.push(current);
      }
      current.messages.push(m);
      pendingUser = true;
      currentRoundId = null;
    } else if (m.role === 'assistant') {
      if (!pendingUser || !current) continue;
      const rid = m.roundId || null;
      if (!current.hasAssistant) {
        current.messages.push(m);
        current.hasAssistant = true;
        currentRoundId = rid;
      } else if (rid && currentRoundId && rid !== currentRoundId) {
        // 同一 AI 消息块里出现新的 roundId：算作另一轮回复（与 countRounds 一致）。
        current = { messages: [m], roundId: rid, hasAssistant: true };
        rounds.push(current);
        currentRoundId = rid;
      } else {
        current.messages.push(m);
      }
    }
  }
  return rounds;
}

/** 一轮消息拼成邻居条目的正文：每条「说话人：正文」，撤回/隐藏的轮次进不到这里。 */
function roundNeighborContent(round, character) {
  const lines = [];
  for (const m of round.messages) {
    const text = extractProtocolText(messageText(m)) || messageText(m);
    if (!String(text || '').trim()) continue;
    const speaker = m.role === 'user' ? (character?.myName || '我') : (character?.realName || '对方');
    lines.push(`${speaker}：${text.trim()}`);
  }
  return lines.join('\n');
}

/**
 * 邻居补全：对一次命中，补同一会话内仍有效的紧邻轮次（前后各 1 轮）。
 * sourceMessageIds 是命中的来源消息（经历的 quotes/sourceMessageIds，
 * 或有出处的总结的 sourceMessageIds）；找不到来源轮次（无出处旧总结、
 * 来源消息已删）时返回 []。每命中最多补 2 条（前 1 轮 + 后 1 轮），
 * 每条邻居代表一整轮：{messageId（该轮首条消息）, messageIds, speaker,
 * role, timestamp, roundOffset:-1|+1, content}。邻居不参与 RRF 打分、
 * 不占 topN 名额，由调用方独立附加。
 */
export function getNeighborContext({ messages, character, sourceMessageIds, maxNeighbors = 2 } = {}) {
  const src = new Set((sourceMessageIds || []).map((id) => String(id)).filter(Boolean));
  if (!src.size) return [];
  const rounds = groupMessagesIntoRounds(messages, character);
  const hitIdx = new Set();
  rounds.forEach((r, i) => {
    if (r.messages.some((m) => src.has(m.id))) hitIdx.add(i);
  });
  if (!hitIdx.size) return [];
  const out = [];
  const seenRounds = new Set();
  for (const i of [...hitIdx].sort((a, b) => a - b)) {
    for (const [j, offset] of [[i - 1, -1], [i + 1, 1]]) {
      if (j < 0 || j >= rounds.length || seenRounds.has(j)) continue;
      seenRounds.add(j);
      const round = rounds[j];
      const content = roundNeighborContent(round, character);
      if (!content) continue;
      const first = round.messages[0];
      out.push({
        messageId: first.id,
        messageIds: round.messages.map((m) => m.id),
        speaker: first.role === 'user' ? (character?.myName || '我') : (character?.realName || '对方'),
        role: first.role,
        timestamp: first.timestamp || null,
        roundOffset: offset,
        content,
      });
      if (out.length >= Math.max(1, maxNeighbors)) return out;
    }
  }
  return out;
}

/** 对一批融合命中逐个补邻居：同一轮邻居只出现一次，并标明它属于哪件命中（docId）。 */
export function collectNeighborsForResults(results, messages, character) {
  const all = [];
  const seen = new Set();
  for (const r of results || []) {
    const ns = getNeighborContext({
      messages, character, sourceMessageIds: r?.sourceMessageIds || [],
    });
    for (const n of ns) {
      const key = n.messageIds.join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({ ...n, docId: r.docId });
    }
  }
  return all;
}

/**
 * 融合检索（第 2 波主入口，放 vectorMemory.js：两路候选都在这里汇合）。
 *
 * fusedRetrieve(backend, char, queryText, queryEmbedding, opts)
 * opts：{spaceKey, journals, experiences, documentsById, history,
 *   topN=5, threshold=0.40, tokenBudget=1500, favoritedIds=[],
 *   keywordTopN=20, vectorTopN=20, countTokens}
 * - 关键词路：searchKeyword，每路按各自排名取前 keywordTopN（默认 20），不设阈值；
 * - 向量路：retrieveVectorCandidates，前 vectorTopN（默认 20），阈值只作用于这一路；
 * - 融合：RRF k=60，只按排名（1/(60+rank)），不混分数；融合后按事件去重
 *   （同一文档 id 只留一件）；再按融合分取 topN；融合后不再二次阈值过滤；
 * - 收藏去重在取 topN 之后、Token 预算之前（被收藏占掉的名额不补，与旧行为一致）；
 * - 两路独立：一路失败/未配置时另一路照常。向量未配置（无 queryEmbedding 或
 *   无 spaceKey）时只走关键词并返回 keywordOnly=true；关键词索引未建时只走
 *   向量并返回 vectorOnly=true。失败不抛到聊天：错误只汇总进 error 字段。
 *
 * 返回 {results, neighbors, error, keywordOnly, vectorOnly, spaceKey, query,
 *   keywordError, vectorError}。
 * results 每条：{docId, docKind, journalId（=docId，旧字段兼容）, title, content,
 *   source, date, timestamp, score（融合分）, keywordRank（null=该路未命中）,
 *   vectorRank（同上）, vectorScore（向量余弦，null=该路未命中；供“测试召回”
 *   显示相关度与阈值校准用）, sourceStatus（'sourced'|'unsourced'）, chunkId（关键词
 *   独占命中时为 null）, sourceMessageIds}。
 * neighbors 每条：{docId（所属命中）, messageId, messageIds, speaker, role,
 *   timestamp, roundOffset:-1|+1, content}。history 未传时 neighbors 为 []。
 * 注意：neighbors 本波只返回、不注入提示词——注入是第 4 波聊天请求重组的事；
 * sourceStatus='unsourced' 的条目可以进 results 供“找到它”，但调用方
 * （第 4 波）决定不把它放进“检索证据”区。
 */
export async function fusedRetrieve(backend, char, queryText, queryEmbedding, opts = {}) {
  const {
    spaceKey = null, journals = [], experiences = [], documentsById = null,
    history = null, topN = 5, threshold = DEFAULT_VECTOR_SETTINGS.threshold,
    tokenBudget = DEFAULT_VECTOR_SETTINGS.tokenBudget, favoritedIds = [],
    keywordTopN = 20, vectorTopN = 20, countTokens,
  } = opts;
  const charId = char?.id;
  const docs = documentsById
    ? [...documentsById.values()].map((d) => normalizeRetrievalDoc(d))
    : retrievalDocsForChar(journals, experiences);
  // 融合前只留当前可检索的文档：关键词索引可能是旧的（失效/关闭检索后
  // 还没来得及同步），不能只靠索引里的 postings 判断——失效经历不可召回。
  const retrievableDocs = docs.filter(retrievalDocRetrievable);
  const byId = new Map(retrievableDocs.map((d) => [d.docId, d]));
  const rawById = new Map();
  for (const d of [...(journals || []), ...(experiences || [])]) rawById.set(d.id, d);
  if (documentsById) for (const [id, d] of documentsById) rawById.set(id, d);

  // 关键词路：索引未建时 searchKeyword 返回 []，与“建了但无命中”用 hasKeywordIndex 区分。
  let keywordRanked = [];
  let keywordError = null;
  let keywordBuilt = false;
  try {
    keywordBuilt = await hasKeywordIndex(backend, charId);
    keywordRanked = await searchKeyword(backend, charId, queryText, { topN: keywordTopN });
  } catch (e) {
    keywordError = e?.message || String(e);
  }

  // 向量路：未配置（无向量或无空间键）时不跑，只走关键词。
  const vectorConfigured = Array.isArray(queryEmbedding) && queryEmbedding.length > 0 && !!spaceKey;
  let vectorRanked = [];
  let vectorError = null;
  if (vectorConfigured) {
    try {
      vectorRanked = await retrieveVectorCandidates({
        backend, charId, spaceKey, queryVector: queryEmbedding,
        documentsById: rawById, topN: vectorTopN, threshold,
      });
    } catch (e) {
      vectorError = e?.message || String(e);
    }
  }

  const fused = rrfFuse(keywordRanked, vectorRanked, RRF_K);
  let results = [...fused.values()]
    .map((f) => {
      const d = byId.get(f.docId);
      if (!d) return null;
      const vHit = vectorRanked.find((v) => v.docId === f.docId);
      return {
        docId: f.docId,
        docKind: d.docKind,
        journalId: f.docId,
        title: d.title,
        content: vHit ? vHit.content : d.content,
        source: d.source,
        date: d.date,
        timestamp: d.timestamp,
        score: f.score,
        keywordRank: f.keywordRank,
        vectorRank: f.vectorRank,
        vectorScore: vHit ? vHit.score : null,
        sourceStatus: d.sourceStatus,
        chunkId: vHit ? vHit.chunkId : null,
        sourceMessageIds: d.sourceMessageIds || [],
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || (a.docId < b.docId ? -1 : 1));
  results = results.slice(0, Math.max(1, topN));
  results = dedupeAgainstFavorited(results, favoritedIds);
  results = applyTokenBudget(results, tokenBudget, countTokens);
  const neighbors = history ? collectNeighborsForResults(results, history, char) : [];
  return {
    results,
    neighbors,
    error: keywordError || vectorError || null,
    keywordError,
    vectorError,
    keywordOnly: !vectorConfigured,
    vectorOnly: vectorConfigured && (!keywordBuilt || !!keywordError),
    spaceKey,
    query: queryText,
  };
}

/* ---------------- 索引同步（第 2 波，供 app.js 的编辑/删除 handler 用） ---------------- */

/**
 * 单文档索引同步：关键词重建该文档 + 向量按 hash 复用或重算。
 * 不参与检索的文档（retrievalEnabled=false / 已失效经历）只清不建。
 * spaceKey/embedTexts 未给时只同步关键词（向量路等下次建索引时补）。
 */
export async function syncDocumentIndexes({
  backend, charId, doc, spaceKey = null, embedTexts = null, saveProgress,
} = {}) {
  const norm = normalizeRetrievalDoc(doc);
  if (!documentRetrievable(doc)) {
    await deleteDocumentIndexes(backend, norm.docId);
    return { docId: norm.docId, removed: true };
  }
  await updateKeywordDoc(backend, norm);
  if (spaceKey && embedTexts) {
    await indexDocuments({
      backend, charId, documents: [doc], spaceKey, embedTexts, saveProgress,
    });
  }
  return { docId: norm.docId, removed: false };
}

/** 删除一条文档的全部索引：向量 chunk + 关键词 postings。返回各路清掉的数量。 */
export async function deleteDocumentIndexes(backend, docId) {
  const vectorChunks = await deleteJournalIndex(backend, docId);
  const keywordPostings = await deleteKeywordDoc(backend, docId);
  return { vectorChunks, keywordPostings };
}

/** 全量重建某角色的关键词索引（建向量索引时顺带调用；无网络请求，纯本地）。 */
export async function rebuildKeywordIndexForChar(backend, charId, journals = [], experiences = []) {
  return buildKeywordIndex(backend, charId, retrievalDocsForChar(journals, experiences));
}

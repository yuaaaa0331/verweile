// keywordSearch.js — 中文关键词检索（第 2 波）。
// JS 自研倒排索引，不引外部库；纯逻辑 + IndexedDB 读写，可被 Node 测试 import。
// 分词：按非字母数字切分；连续汉字取相邻两字 bigram + 完整词串，
// 英文/数字按词切分并小写化。停用词表只去最常见的虚词（“的/了/是/在/和”
// 一类），绝不去实词——“海边”“香菜”“猫”这类词必须能命中。
// 单个汉字不再当 term：单字在中文里几乎没有区分度，“天/好”这类单字
// 会把无关文档也召回（见 4b：“今天中午吃什么拉面好呢”误召回 3 条经历）。
// 索引与查询都只保留二元字串与完整词串；命中还要求至少含一个长度 ≥2 的
// term（二元字串 / 完整词串 / 多字词），只有单字/单字母命中的文档不要。
// 打分：BM25（k1=1.2、b=0.75，IDF = ln(1 + (N - df + 0.5)/(df + 0.5))）。
// 索引写进 keywordIndex store（DB v3 已建，keyPath 'id'）：
// 每条记录 {id:`${charId}:${term}`, charId, term,
//   postings:[{docId, docKind:'journal'|'experience', tf, docLen}]}。
// 索引文档 = 可检索的记忆与经历；无原文出处的旧总结也可以进索引用于
// “找到它”，但返回时标 sourceStatus='unsourced'，由调用方决定不进“检索证据”区。
import { isExperienceValid, sourceStatusOfJournal } from './experiences.js';

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** 停用词：只去最常见的虚词。单字虚词与英文虚词各一小撮，实词一律保留。 */
export const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '但', '就', '也', '都', '还', '很', '最',
  '呢', '吗', '吧', '啊', '哦', '嗯', '这', '那', '着', '过', '之', '我', '你', '他', '她', '它',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'be',
]);

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ALNUM_RE = /[A-Za-z0-9]/;

/**
 * 分词：返回含重复的 term 列表（重复次数即词频 tf）。
 * 连续汉字串：完整词串 + 相邻两字 bigram；单个汉字不当 term（无区分度，
 * 会把无关文档召回，见文件头）；英文/数字串：整词小写；其余字符只作分隔符。
 */
export function tokenize(text) {
  const s = String(text || '');
  const terms = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (CJK_RE.test(ch)) {
      let j = i;
      while (j < s.length && CJK_RE.test(s[j])) j++;
      const run = s.slice(i, j);
      if (run.length > 1) terms.push(run);
      // 单个汉字不当 term：单字几乎没有区分度（“天/好”会误召回无关文档）。
      for (let k = 0; k + 1 < run.length; k++) terms.push(run.slice(k, k + 2));
      i = j;
    } else if (ALNUM_RE.test(ch)) {
      let j = i;
      while (j < s.length && ALNUM_RE.test(s[j])) j++;
      terms.push(s.slice(i, j).toLowerCase());
      i = j;
    } else {
      i++;
    }
  }
  return terms.filter((t) => t && !STOPWORDS.has(t));
}

/** 经历的检索正文：关键细节 + 关键原话（原话是经历的证据，也是关键词来源）。 */
export function experienceContent(exp) {
  const quotes = (exp?.quotes || []).map((q) => q?.text || '').filter(Boolean);
  return [exp?.summary || '', ...quotes].filter(Boolean).join('\n');
}

/** 记忆的检索正文：就是 content。 */
export function journalContent(journal) {
  return String(journal?.content || '');
}

/**
 * 把一条原始记忆 / 经历归一化成检索文档。
 * {docId, docKind:'journal'|'experience', charId, title, content, source,
 *  date, timestamp, sourceStatus:'sourced'|'unsourced', sourceMessageIds,
 *  retrievalEnabled, text}。text 是分词的输入（标题 + 内容）。
 * 经历没有 quotes/sourceMessageIds 时 sourceStatus 为 'unsourced'。
 */
export function normalizeRetrievalDoc(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('检索文档不能为空。');
  const docId = doc.docId || doc.id;
  if (!docId) throw new Error('检索文档需要 id。');
  const docKind = doc.docKind || doc.kind
    || (Array.isArray(doc.quotes) || typeof doc.summary === 'string' ? 'experience' : 'journal');
  const isExp = docKind === 'experience';
  const content = isExp ? experienceContent(doc) : journalContent(doc);
  const title = String(doc.title || '');
  const sourceMessageIds = [...new Set(
    (Array.isArray(doc.sourceMessageIds) ? doc.sourceMessageIds : [])
      .concat((doc.quotes || []).map((q) => q?.messageId).filter(Boolean))
      .map((id) => String(id)).filter(Boolean),
  )];
  const sourceStatus = isExp
    ? (sourceMessageIds.length ? 'sourced' : 'unsourced')
    : sourceStatusOfJournal(doc);
  const ts = Number.isFinite(doc.timestamp) ? doc.timestamp
    : (Number.isFinite(doc.createdAt) ? doc.createdAt : 0);
  return {
    docId,
    docKind,
    charId: doc.charId || '',
    title,
    content,
    source: doc.source || (isExp ? '经历提取' : '手动记录'),
    date: ts ? new Date(ts).toISOString().slice(0, 10) : '',
    timestamp: ts,
    sourceStatus,
    sourceMessageIds,
    retrievalEnabled: doc.retrievalEnabled !== false,
    valid: isExp ? isExperienceValid(doc) : true,
    text: [title, content].filter(Boolean).join('\n'),
  };
}

export function keywordDocFromJournal(journal) {
  return normalizeRetrievalDoc({ ...journal, docKind: 'journal' });
}

export function keywordDocFromExperience(exp) {
  return normalizeRetrievalDoc({ ...exp, docKind: 'experience' });
}

/** 记忆 + 经历拼成检索文档列表（fusedRetrieve 与索引重建共用）。 */
export function retrievalDocsForChar(journals = [], experiences = []) {
  const docs = [];
  for (const j of journals || []) docs.push(keywordDocFromJournal(j));
  for (const e of experiences || []) docs.push(keywordDocFromExperience(e));
  return docs;
}

/** 这条文档是否参与检索：记忆看 retrievalEnabled；经历还要有效（未失效）。 */
export function retrievalDocRetrievable(doc) {
  const d = doc?.docId ? doc : normalizeRetrievalDoc(doc);
  if (d.retrievalEnabled === false) return false;
  if (d.docKind === 'experience' && d.valid === false) return false;
  return true;
}

/** 该角色的关键词索引是否已建（有任意倒排记录即算已建）。 */
export async function hasKeywordIndex(backend, charId) {
  const all = await backend.getAll('keywordIndex');
  return all.some((r) => r?.charId === charId);
}

/** 删掉该角色的全部倒排记录（重建前调用）。 */
async function clearKeywordIndexForChar(backend, charId) {
  const all = await backend.getAll('keywordIndex');
  for (const r of all.filter((x) => x?.charId === charId)) {
    await backend.delete('keywordIndex', r.id);
  }
}

/**
 * 全量重建某角色的关键词索引：先清该角色旧记录，再按文档写倒排。
 * 不参与检索的文档（retrievalEnabled=false / 已失效经历）不进索引。
 * 返回 {charId, docs, terms}。
 */
export async function buildKeywordIndex(backend, charId, docs) {
  if (!charId) throw new Error('建关键词索引需要 charId。');
  await clearKeywordIndexForChar(backend, charId);
  const byTerm = new Map(); // term -> Map(docId -> posting)
  let docCount = 0;
  for (const raw of docs || []) {
    const doc = raw?.docId ? raw : normalizeRetrievalDoc(raw);
    if (doc.charId && doc.charId !== charId) continue;
    if (!retrievalDocRetrievable(doc)) continue;
    const terms = tokenize(doc.text);
    if (!terms.length) continue;
    docCount++;
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [term, count] of tf) {
      if (!byTerm.has(term)) byTerm.set(term, new Map());
      byTerm.get(term).set(doc.docId, {
        docId: doc.docId, docKind: doc.docKind, tf: count, docLen: terms.length,
      });
    }
  }
  for (const [term, postings] of byTerm) {
    await backend.put('keywordIndex', {
      id: `${charId}:${term}`, charId, term, postings: [...postings.values()],
    });
  }
  return { charId, docs: docCount, terms: byTerm.size };
}

/** 从全部倒排记录里删掉某文档的 postings；变空的 term 记录随之删除。返回清掉的 posting 数。 */
async function removeDocFromPostings(backend, docId, onlyCharId = null) {
  const all = await backend.getAll('keywordIndex');
  let removed = 0;
  for (const row of all) {
    if (onlyCharId && row?.charId !== onlyCharId) continue;
    if (!Array.isArray(row?.postings) || !row.postings.some((p) => p.docId === docId)) continue;
    const rest = row.postings.filter((p) => p.docId !== docId);
    removed += row.postings.length - rest.length;
    if (!rest.length) await backend.delete('keywordIndex', row.id);
    else await backend.put('keywordIndex', { ...row, postings: rest });
  }
  return removed;
}

/**
 * 单文档同步：先清掉该文档的旧 postings，再按新内容重建。
 * 不参与检索的文档（retrievalEnabled=false / 已失效经历）只清不建——
 * 编辑后立即不可见就靠这一步。doc 必须带 charId（没有时按 docId 全库扫描）。
 */
export async function updateKeywordDoc(backend, doc) {
  const d = doc?.docId ? doc : normalizeRetrievalDoc(doc);
  if (!d.docId) throw new Error('更新关键词索引需要文档 id。');
  if (!retrievalDocRetrievable(d)) {
    // 不参与检索：只清不建（charId 缺失时按 docId 全库扫描）。
    await removeDocFromPostings(backend, d.docId, d.charId || null);
    return { docId: d.docId, indexed: false };
  }
  if (!d.charId) throw new Error('更新关键词索引需要 charId。');
  await removeDocFromPostings(backend, d.docId, d.charId || null);
  const terms = tokenize(d.text);
  if (!terms.length) return { docId: d.docId, indexed: false };
  const tf = new Map();
  for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [term, count] of tf) {
    const id = `${d.charId}:${term}`;
    const row = (await backend.get('keywordIndex', id))
      || { id, charId: d.charId, term, postings: [] };
    const postings = row.postings.filter((p) => p.docId !== d.docId);
    postings.push({ docId: d.docId, docKind: d.docKind, tf: count, docLen: terms.length });
    await backend.put('keywordIndex', { ...row, postings });
  }
  return { docId: d.docId, indexed: true };
}

/** 删除一条文档的全部关键词 postings（记忆/经历删除时调用）。返回清掉的 posting 数。 */
export async function deleteKeywordDoc(backend, docId) {
  if (!docId) return 0;
  return removeDocFromPostings(backend, docId);
}

/**
 * 关键词检索：BM25 打分，按分降序返回 [{docId, docKind, score, rank}]。
 * 不设分数阈值——有命中即候选，靠 RRF 排名与 topN 控制；但有一道 term 形状门：
 * 命中至少包含一个长度 ≥2 的 term（二元字串 / 完整词串 / 多字词），只有
 * 单字/单字母命中的文档不要——单字在中文里几乎没有区分度，任意 score>0
 * 即入选会把无关话题也召回（见 4b）。返回 [] 只表示本路无命中。
 * N 是该角色索引里的文档总数，avgdl 是它们的平均长度。
 */
export async function searchKeyword(backend, charId, query, { topN = 5 } = {}) {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length || !charId) return [];
  const rows = (await backend.getAll('keywordIndex')).filter((r) => r?.charId === charId);
  if (!rows.length) return [];
  // 该角色的文档集合：docLen 取任意一条 posting 里的值（同一文档各 term 的 docLen 相同）。
  const docInfo = new Map(); // docId -> {docKind, docLen}
  for (const row of rows) {
    for (const p of row.postings || []) {
      if (!docInfo.has(p.docId)) docInfo.set(p.docId, { docKind: p.docKind, docLen: p.docLen || 0 });
    }
  }
  const N = docInfo.size;
  if (!N) return [];
  const avgdl = [...docInfo.values()].reduce((s, d) => s + (d.docLen || 0), 0) / N || 1;
  const scores = new Map(); // docId -> score
  const matchedTerms = new Map(); // docId -> Set(term)，供 term 形状门用
  for (const term of queryTerms) {
    const row = rows.find((r) => r.term === term);
    if (!row?.postings?.length) continue;
    const df = row.postings.length;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (const p of row.postings) {
      const docLen = p.docLen || 0;
      const tfPart = (p.tf * (BM25_K1 + 1))
        / (p.tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgdl)));
      scores.set(p.docId, (scores.get(p.docId) || 0) + idf * tfPart);
      if (!matchedTerms.has(p.docId)) matchedTerms.set(p.docId, new Set());
      matchedTerms.get(p.docId).add(term);
    }
  }
  const ranked = [...scores.entries()]
    // term 形状门：至少命中一个长度 ≥2 的 term。单字 term 已不在分词里，
    // 这道门防的是旧索引里的单字行、以及单字母词等残留噪声。
    .filter(([docId]) => {
      const terms = matchedTerms.get(docId);
      if (!terms) return false;
      for (const t of terms) if (t.length >= 2) return true;
      return false;
    })
    .map(([docId, score]) => ({
      docId, docKind: docInfo.get(docId)?.docKind || 'journal', score,
    }))
    .sort((a, b) => b.score - a.score || (a.docId < b.docId ? -1 : 1))
    .slice(0, Math.max(1, topN));
  return ranked.map((r, i) => ({ ...r, rank: i + 1 }));
}

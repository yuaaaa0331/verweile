// retrievalWorker.js — 第 4 波：较重计算的 Worker 与批量任务队列。
//
// 本文件分两层：
//  1. Worker 层：RETRIEVAL_WORKER_SOURCE 是完整的 Worker 源码字符串，
//     由调用方用 Blob URL 创建 Worker（预览是单文件 artifact，独立 worker
//     文件走不到）。Worker 内只做两件纯计算：关键词倒排构建、余弦打分；
//     源码自包含、不 import 任何业务模块。
//  2. 主线程层：与 Worker 源码同一份算法的纯函数（回退用）、Worker 创建与
//     任务执行（含建不出 Worker 时的主线程分片回退）、批量任务队列的纯逻辑
//     （任务记录、暂停/恢复、进度持久化）与整角色删除时的检索残留清理。
// 本文件不 import 业务模块、不碰 DOM、不调网络，可被 Node 测试直接 import。
// 注意：RETRIEVAL_WORKER_SOURCE 里不能出现反引号与 ${}（它是外层模板字符串）。

/* ---------------- Worker 源码字符串 ---------------- */

export const RETRIEVAL_WORKER_SOURCE = `
'use strict';
var STOPWORDS = {};
['的','了','是','在','和','与','或','但','就','也','都','还','很','最','呢','吗','吧','啊','哦','嗯','这','那','着','过','之','我','你','他','她','它','the','a','an','and','or','of','to','in','is','are','was','were','be'].forEach(function (w) { STOPWORDS[w] = true; });
var CJK_RE = /[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]/;
var ALNUM_RE = /[A-Za-z0-9]/;
function tokenize(text) {
  var s = String(text || '');
  var terms = [];
  var i = 0;
  while (i < s.length) {
    var ch = s[i];
    if (CJK_RE.test(ch)) {
      var j = i;
      while (j < s.length && CJK_RE.test(s[j])) j++;
      var run = s.slice(i, j);
      if (run.length > 1) terms.push(run);
      // 单个汉字不当 term：单字几乎没有区分度（与 keywordSearch.tokenize 同算法）。
      for (var k2 = 0; k2 + 1 < run.length; k2++) terms.push(run.slice(k2, k2 + 2));
      i = j;
    } else if (ALNUM_RE.test(ch)) {
      var j2 = i;
      while (j2 < s.length && ALNUM_RE.test(s[j2])) j2++;
      terms.push(s.slice(i, j2).toLowerCase());
      i = j2;
    } else {
      i++;
    }
  }
  return terms.filter(function (t) { return t && !STOPWORDS[t]; });
}
function buildPostings(docs) {
  var byTerm = {};
  for (var d = 0; d < (docs || []).length; d++) {
    var doc = docs[d];
    var terms = tokenize(doc.text || '');
    if (!terms.length) continue;
    var tf = {};
    for (var i = 0; i < terms.length; i++) tf[terms[i]] = (tf[terms[i]] || 0) + 1;
    for (var term in tf) {
      if (!byTerm[term]) byTerm[term] = [];
      byTerm[term].push({ docId: doc.docId, docKind: doc.docKind || 'journal', tf: tf[term], docLen: terms.length });
    }
  }
  var out = [];
  for (var term2 in byTerm) out.push({ term: term2, postings: byTerm[term2] });
  out.sort(function (a, b) { return a.term < b.term ? -1 : a.term > b.term ? 1 : 0; });
  return { postings: out, docs: (docs || []).length };
}
function cosine(a, b) {
  if (!a || !b || !a.length || a.length !== b.length) return 0;
  var dot = 0, na = 0, nb = 0;
  for (var i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function scoreEntries(queryVector, entries) {
  var out = [];
  for (var i = 0; i < (entries || []).length; i++) {
    var e = entries[i];
    if (!e || !e.vector) continue;
    out.push({ id: e.id, score: cosine(queryVector, e.vector) });
  }
  out.sort(function (a, b) { return b.score - a.score; });
  return out;
}
self.onmessage = function (e) {
  var msg = e.data || {};
  try {
    var result = null;
    if (msg.kind === 'build-keyword-postings') {
      result = buildPostings((msg.payload || {}).docs || []);
    } else if (msg.kind === 'cosine-scores') {
      result = scoreEntries((msg.payload || {}).queryVector, (msg.payload || {}).entries || []);
    } else {
      throw new Error('未知的 Worker 任务：' + String(msg.kind));
    }
    self.postMessage({ id: msg.id, ok: true, result: result });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
};
`;

/* ---------------- 主线程纯函数（与 Worker 同算法，回退用） ---------------- */

export const WORKER_STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '但', '就', '也', '都', '还', '很', '最',
  '呢', '吗', '吧', '啊', '哦', '嗯', '这', '那', '着', '过', '之', '我', '你', '他', '她', '它',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'be',
]);

const CJK_RE_MAIN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ALNUM_RE_MAIN = /[A-Za-z0-9]/;

/** 分词（与 keywordSearch.tokenize 同算法；Worker 源码里是同一份逻辑的 ES5 版）。 */
export function tokenizeText(text) {
  const s = String(text || '');
  const terms = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (CJK_RE_MAIN.test(ch)) {
      let j = i;
      while (j < s.length && CJK_RE_MAIN.test(s[j])) j++;
      const run = s.slice(i, j);
      if (run.length > 1) terms.push(run);
      // 单个汉字不当 term：单字几乎没有区分度（与 keywordSearch.tokenize 同算法）。
      for (let k = 0; k + 1 < run.length; k++) terms.push(run.slice(k, k + 2));
      i = j;
    } else if (ALNUM_RE_MAIN.test(ch)) {
      let j = i;
      while (j < s.length && ALNUM_RE_MAIN.test(s[j])) j++;
      terms.push(s.slice(i, j).toLowerCase());
      i = j;
    } else {
      i++;
    }
  }
  return terms.filter((t) => t && !WORKER_STOPWORDS.has(t));
}

/**
 * 关键词倒排构建（与 keywordSearch.buildKeywordIndex 同算法、与 Worker
 * 源码同一份逻辑）：docs [{docId, docKind, text}] → {postings:[{term, postings:
 * [{docId, docKind, tf, docLen}]}], docs}。写库由调用方做（Worker 只算不写）。
 */
export function buildKeywordPostings(docs) {
  const byTerm = new Map();
  for (const doc of docs || []) {
    const terms = tokenizeText(doc?.text || '');
    if (!terms.length) continue;
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [term, count] of tf) {
      if (!byTerm.has(term)) byTerm.set(term, []);
      byTerm.get(term).push({
        docId: doc.docId, docKind: doc.docKind || 'journal', tf: count, docLen: terms.length,
      });
    }
  }
  const postings = [...byTerm.entries()]
    .map(([term, list]) => ({ term, postings: list }))
    .sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  return { postings, docs: (docs || []).length };
}

/** 余弦相似度（与 vectorMemory.cosineSimilarity 同公式）。 */
export function cosineSimilarityLocal(a, b) {
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

/** 余弦打分并降序：entries [{id, vector}] → [{id, score}]（不过滤阈值，由调用方定）。 */
export function scoreCosineEntries(queryVector, entries) {
  const out = [];
  for (const e of entries || []) {
    if (!e?.vector) continue;
    out.push({ id: e.id, score: cosineSimilarityLocal(queryVector, e.vector) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/* ---------------- Worker 创建与任务执行（含主线程分片回退） ---------------- */

/** 当前环境能不能建 Worker（Blob URL 方式；预览单文件 artifact 里同样走这条路）。 */
export function isWorkerSupported() {
  try {
    return typeof Worker === 'function'
      && typeof Blob === 'function'
      && typeof URL !== 'undefined'
      && typeof URL.createObjectURL === 'function';
  } catch {
    return false;
  }
}

/**
 * 创建 Worker：成功返回 {worker, url}，失败（Blob URL 被禁、无 Worker 支持等）
 * 返回 null，由调用方走主线程分片回退。绝不抛错。
 */
export function createRetrievalWorker() {
  if (!isWorkerSupported()) return null;
  try {
    const url = URL.createObjectURL(
      new Blob([RETRIEVAL_WORKER_SOURCE], { type: 'text/javascript' }),
    );
    return { worker: new Worker(url), url };
  } catch {
    return null;
  }
}

export function terminateRetrievalWorker(handle) {
  if (!handle) return;
  try { handle.worker?.terminate(); } catch { /* 已停用 */ }
  try { if (handle.url) URL.revokeObjectURL(handle.url); } catch { /* 已释放 */ }
}

let workerTaskSeq = 0;

/** 一次 Worker 调用：按 id 配对回包；超时或 Worker 报错都 reject（调用方回退主线程）。 */
export function runWorkerTask(handle, kind, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = `wt_${++workerTaskSeq}_${Date.now()}`;
    let timer = null;
    const done = (fn, arg) => {
      if (timer) clearTimeout(timer);
      handle.worker.onmessage = null;
      handle.worker.onerror = null;
      fn(arg);
    };
    timer = setTimeout(() => done(reject, new Error('Worker 任务超时')), timeoutMs);
    handle.worker.onerror = (e) => done(reject, new Error(`Worker 出错：${e?.message || '未知错误'}`));
    handle.worker.onmessage = (e) => {
      const msg = e?.data || {};
      if (msg.id !== id) return;
      if (msg.ok) done(resolve, msg.result);
      else done(reject, new Error(msg.error || 'Worker 任务失败'));
    };
    try {
      handle.worker.postMessage({ id, kind, payload });
    } catch (e) {
      done(reject, e);
    }
  });
}

/** 让出主线程一片（分片执行的片间让步，手机不卡）。 */
export function yieldToMain() {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * 执行一次检索计算任务：优先 Worker，建不出 Worker 或 Worker 失败时回退到
 * 主线程分片让步执行（每片限时：build-keyword-postings 每片 50 篇文档、
 * cosine-scores 每片 200 条向量，片间 await 让步）。
 * kind: 'build-keyword-postings' | 'cosine-scores'。
 * options: {createWorker（可注入 fake，默认 createRetrievalWorker）,
 *   onProgress({done, total, mode}), timeoutMs}。
 * 返回 {result, mode:'worker'|'main'}；mode 会写进任务记录，进度里注明“主线程模式”。
 */
export async function executeRetrievalTask(kind, payload, {
  createWorker = createRetrievalWorker, onProgress, timeoutMs = 30000,
} = {}) {
  if (kind !== 'build-keyword-postings' && kind !== 'cosine-scores') {
    throw new Error(`未知的检索计算任务：${kind}`);
  }
  const handle = (() => {
    try { return createWorker(); } catch { return null; }
  })();
  if (handle) {
    try {
      const result = await runWorkerTask(handle, kind, payload, timeoutMs);
      return { result, mode: 'worker' };
    } catch (e) {
      // Worker 失败：落到主线程分片回退，不抛错阻断任务。
      try { console.warn('Worker 任务失败，已回退主线程分片执行：', e); } catch { /* Node 下 console 一定在 */ }
    } finally {
      terminateRetrievalWorker(handle);
    }
  }
  // 主线程分片回退。
  if (kind === 'build-keyword-postings') {
    const docs = payload?.docs || [];
    const total = docs.length;
    const all = { postings: [], docs: total };
    const byTerm = new Map();
    for (let i = 0; i < docs.length; i += 50) {
      const slice = docs.slice(i, i + 50);
      const part = buildKeywordPostings(slice);
      for (const row of part.postings) {
        if (!byTerm.has(row.term)) byTerm.set(row.term, []);
        byTerm.get(row.term).push(...row.postings);
      }
      onProgress?.({ done: Math.min(i + 50, total), total, mode: 'main' });
      if (i + 50 < docs.length) await yieldToMain();
    }
    all.postings = [...byTerm.entries()]
      .map(([term, list]) => ({ term, postings: list }))
      .sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
    return { result: all, mode: 'main' };
  }
  const entries = payload?.entries || [];
  const total = entries.length;
  const scored = [];
  for (let i = 0; i < entries.length; i += 200) {
    const slice = entries.slice(i, i + 200);
    scored.push(...scoreCosineEntries(payload?.queryVector, slice));
    onProgress?.({ done: Math.min(i + 200, total), total, mode: 'main' });
    if (i + 200 < entries.length) await yieldToMain();
  }
  scored.sort((a, b) => b.score - a.score);
  return { result: scored, mode: 'main' };
}

/* ---------------- 批量任务队列（记忆页） ---------------- */

export const MEMORY_JOBS_KEY = 'memoryJobs';
export const MEMORY_JOB_KINDS = ['extract-all', 'backfill-clues', 'rebuild-keyword', 'rebuild-vector'];
export const MEMORY_JOB_LABELS = {
  'extract-all': '为全部历史提取经历',
  'backfill-clues': '为旧经历补线索',
  'rebuild-keyword': '重建关键词索引',
  'rebuild-vector': '重建向量索引',
};
export const MEMORY_JOB_SLICE_SIZE = 10;

function jobUid() {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 新建任务记录。status: 'pending' | 'running' | 'paused' | 'done' | 'error'；
 * done/total 是进度（已处理/总数）；phase 是当前阶段文案；mode 是
 * 'worker' | 'main' | null（main 即主线程模式）；error 是出错信息。
 * 任务不开机自动跑：只有用户点开始/继续才进入 running。
 */
export function createMemoryJob(kind, charId, total = 0) {
  if (!MEMORY_JOB_KINDS.includes(kind)) throw new Error(`未知的批量任务：${kind}`);
  const now = Date.now();
  return {
    id: jobUid(), kind, charId, status: 'pending',
    done: 0, total, failed: 0, skipped: 0,
    phase: '', mode: null, error: null, note: '',
    createdAt: now, updatedAt: now,
  };
}

/** 读全部任务记录（settings 'memoryJobs'，{jobId: job}；无记录返回 {}）。 */
export async function loadMemoryJobs(backend) {
  const row = await backend.get('settings', MEMORY_JOBS_KEY);
  const v = row?.value;
  return v && typeof v === 'object' ? { ...v } : {};
}

/** 写全部任务记录。 */
export async function saveMemoryJobs(backend, jobs) {
  await backend.put('settings', { key: MEMORY_JOBS_KEY, value: { ...jobs } });
  return jobs;
}

/** 单条任务记录写回（读-改-写；队列一次只跑一个任务，不竞态）。 */
export async function persistMemoryJob(backend, job) {
  const jobs = await loadMemoryJobs(backend);
  jobs[job.id] = { ...job, updatedAt: Date.now() };
  await saveMemoryJobs(backend, jobs);
  return jobs[job.id];
}

/**
 * 页面重新打开时：上次还是 running 的任务一定是页面关闭时中断的——绝不假装
 * 它仍在后台持续运行，改成 paused 并注明“页面关闭时中断”，等用户点继续。
 * 返回 {jobs, changed}。
 */
export function markInterruptedJobsPaused(jobs) {
  const next = { ...(jobs || {}) };
  let changed = false;
  for (const job of Object.values(next)) {
    if (job?.status === 'running') {
      next[job.id] = {
        ...job, status: 'paused',
        note: '页面关闭时中断，未继续运行；点“继续”可接着做。',
        updatedAt: Date.now(),
      };
      changed = true;
    }
  }
  return { jobs: next, changed };
}

/** 任务给记忆页看的状态文案（含进度与模式）。 */
export function memoryJobStatusText(job) {
  if (!job) return '';
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  const state = {
    pending: '待开始', running: '进行中', paused: '已暂停',
    done: '已完成', error: '出错',
  }[job.status] || job.status;
  const mode = job.mode === 'main' ? '（主线程模式）' : job.mode === 'worker' ? '（Worker 模式）' : '';
  const tail = job.status === 'done'
    ? `，失败 ${job.failed || 0} 件，跳过 ${job.skipped || 0} 件`
    : job.error ? `：${job.error}` : '';
  return `${state} ${job.done}/${job.total}（${pct}%）${mode}${job.phase ? ` · ${job.phase}` : ''}${tail}`;
}

/**
 * 分片跑一个批量任务：items 逐片处理（默认每片 10 件），片间检查 signal、
 * 写进度、让出主线程。单件失败只计 failed，不阻断整批；processItem 返回
 * 'skip' 计 skipped。暂停时 status='paused'，已写进度保留；恢复时从
 * job.done 继续，不重复处理已完成的件。
 * options: {backend（默认写进度用）, job, items, processItem(item, index),
 *   onProgress(job), signal {cancelled}, sliceSize=10, saveProgress(job)}。
 * 返回 {...job, cancelled, failed, skipped}。
 */
export async function runMemoryJob({
  backend, job, items, processItem,
  onProgress, signal, sliceSize = MEMORY_JOB_SLICE_SIZE, saveProgress,
} = {}) {
  if (!job) throw new Error('跑批量任务需要任务记录。');
  const list = items || [];
  job.total = list.length;
  job.status = 'running';
  job.error = null;
  job.updatedAt = Date.now();
  const save = saveProgress
    || (backend ? (j) => persistMemoryJob(backend, j) : null);
  let failed = job.failed || 0;
  let skipped = job.skipped || 0;
  await save?.({ ...job });
  onProgress?.({ ...job });
  try {
    for (let i = job.done; i < list.length;) {
      if (signal?.cancelled) {
        job.status = 'paused';
        job.updatedAt = Date.now();
        await save?.({ ...job });
        onProgress?.({ ...job });
        return { ...job, cancelled: true, failed, skipped };
      }
      const slice = list.slice(i, i + Math.max(1, sliceSize));
      for (const item of slice) {
        try {
          const r = await processItem(item, i);
          if (r === 'skip') skipped++;
        } catch {
          failed++;
        }
        i++;
        job.done = i;
        job.failed = failed;
        job.skipped = skipped;
        job.updatedAt = Date.now();
      }
      await save?.({ ...job });
      onProgress?.({ ...job });
      await yieldToMain();
    }
  } catch (e) {
    job.status = 'error';
    job.error = e?.message || String(e);
    job.updatedAt = Date.now();
    await save?.({ ...job });
    onProgress?.({ ...job });
    throw e;
  }
  job.status = 'done';
  job.failed = failed;
  job.skipped = skipped;
  job.updatedAt = Date.now();
  await save?.({ ...job });
  onProgress?.({ ...job });
  return { ...job, cancelled: false, failed, skipped };
}

/** 这件经历是否需要补线索：无线索，或线索的 evidenceVersion 已过期（version 不符）。 */
export function experienceNeedsClues(exp) {
  if (!exp) return false;
  const version = exp?.version;
  const valid = (exp?.clues || []).filter((c) => c && c.evidenceVersion === version);
  return valid.length === 0;
}

/**
 * 整角色删除时的检索残留清理：该角色的 experiences、keywordIndex 记录与
 * vectorChunks 一起清掉（复用 deleteSpaceIndex / deleteJournalIndex 的模式：
 * 按 charId 过滤、逐条删）。返回各路清掉的数量。
 */
export async function cleanupCharacterRetrievalData(backend, charId) {
  if (!charId) return { experiences: 0, keywordIndex: 0, vectorChunks: 0 };
  const counts = { experiences: 0, keywordIndex: 0, vectorChunks: 0 };
  for (const e of (await backend.getAll('experiences')).filter((x) => x?.charId === charId)) {
    await backend.delete('experiences', e.id);
    counts.experiences++;
  }
  for (const r of (await backend.getAll('keywordIndex')).filter((x) => x?.charId === charId)) {
    await backend.delete('keywordIndex', r.id);
    counts.keywordIndex++;
  }
  for (const c of (await backend.getAll('vectorChunks')).filter((x) => x?.charId === charId)) {
    await backend.delete('vectorChunks', c.id);
    counts.vectorChunks++;
  }
  return counts;
}

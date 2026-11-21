// server.mjs — wake-push-service 最小可选后台（Node 18+，仅依赖 web-push）。
// 只做三件事：保存推送订阅、到期检查（定时器或手动 POST /tick）、
// 发 Web Push。VAPID 密钥由用户自己生成放 .env，不内置密钥。
// 只存订阅端点与唤醒元数据（endpoint、keys、charId、wakeId、trigger、
// 下次时间）；不上传聊天正文与 API 密钥；推送 payload 只含通用标题
// （“有新消息”/唤醒原因），不含消息内容。
// 未部署它时前端仍以前端运行模式工作，不假装有后台能力。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const SUBS_FILE = resolve(root, 'subscriptions.json');
const PORT = Number(process.env.PORT || 8787);

function loadEnv() {
  const envPath = resolve(root, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

let webpush = null;
async function getWebPush() {
  if (webpush) return webpush;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error('未配置 VAPID 密钥：请按 README 生成后填入 .env（不要把私钥提交到仓库）。');
  }
  const mod = await import('web-push');
  webpush = mod.default || mod;
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:you@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return webpush;
}

function loadSubs() {
  try { return JSON.parse(readFileSync(SUBS_FILE, 'utf8')); } catch { return []; }
}
function saveSubs(subs) { writeFileSync(SUBS_FILE, `${JSON.stringify(subs, null, 2)}\n`, 'utf8'); }

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) reject(new Error('body too large')); });
    req.on('end', () => { try { resolveBody(body ? JSON.parse(body) : {}); } catch { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// 到期检查：订阅记录里 wakeJobs 的 nextAt 到了就发一条通用唤醒推送。
// payload 只含 wakeId/trigger/通用文案，不含聊天正文。
export async function tick(nowMs = Date.now()) {
  const wp = await getWebPush();
  const subs = loadSubs();
  let sent = 0; let expired = 0;
  for (const sub of subs) {
    const dueJobs = (sub.wakeJobs || []).filter((j) => j.nextAt <= nowMs);
    for (const job of dueJobs) {
      try {
        await wp.sendNotification(sub.subscription, JSON.stringify({
          title: 'verweile',
          body: job.trigger || '到时间了，回来看看吧',
          wakeId: job.wakeId, charId: sub.charId || null, url: '/',
        }));
        sent += 1;
      } catch {
        expired += 1; // 订阅失效：记下，由下次 /subscribe 覆盖
      }
    }
    sub.wakeJobs = (sub.wakeJobs || []).filter((j) => j.nextAt > nowMs);
  }
  saveSubs(subs);
  return { sent, expired };
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'wake-push-service' });
    if (req.method === 'POST' && req.url === '/subscribe') {
      const body = await readJson(req);
      if (!body?.subscription?.endpoint) return send(res, 400, { ok: false, reason: '缺少 subscription.endpoint' });
      const subs = loadSubs().filter((s) => s.subscription.endpoint !== body.subscription.endpoint);
      // 只存订阅端点与唤醒元数据，不存聊天正文与 API 密钥。
      subs.push({
        subscription: { endpoint: body.subscription.endpoint, keys: body.subscription.keys || {} },
        charId: body.charId || null,
        wakeJobs: Array.isArray(body.wakeJobs) ? body.wakeJobs.map((j) => ({ wakeId: j.wakeId, trigger: j.trigger || '', nextAt: Number(j.nextAt) })).filter((j) => Number.isFinite(j.nextAt)) : [],
        updatedAt: Date.now(),
      });
      saveSubs(subs);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/unsubscribe') {
      const body = await readJson(req);
      saveSubs(loadSubs().filter((s) => s.subscription.endpoint !== body?.endpoint));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/tick') {
      const result = await tick();
      return send(res, 200, { ok: true, ...result });
    }
    return send(res, 404, { ok: false, reason: 'not found' });
  } catch (e) {
    return send(res, 500, { ok: false, reason: e?.message || String(e) });
  }
});

// 每 60 秒自动检查一次；也可以手动 POST /tick。
setInterval(() => { tick().catch(() => {}); }, 60 * 1000);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`wake-push-service listening on :${PORT}`));
}
export { server };

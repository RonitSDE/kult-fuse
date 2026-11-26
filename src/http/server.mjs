import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from './runtime.mjs';
import { handlePredictApi, startPredictReconciler } from '../predict/api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const webRoot = path.join(root, 'web');
const predictWebRoot = path.join(root,'apps/predict/dist');
const port = Number(process.env.PORT || 8787);
const VERSION = '2.1.4';
const runtime = await new Runtime(process.env).start();
if (!runtime.live) console.warn(`setup mode: ${runtime.setupError}`);

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}

function authorized(req) {
  const expected = process.env.FUSE_ADMIN_TOKEN;
  if (!expected || expected.startsWith('CHANGE_ME')) return false;
  const given = Buffer.from(req.headers.authorization || '');
  const want = Buffer.from(`Bearer ${expected}`);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// Public verification is globally rate-limited rather than relying on spoofable
// X-Forwarded-For headers; operators can request signed policy previews.
import { createVerifyLimiter } from './verify-limiter.mjs';
const verifyLimiter = createVerifyLimiter();
const agentCheckLimiter = createVerifyLimiter({ maxPerMinute: 240 });
const PUBLIC_POSTS = new Set(['/api/verify']);

async function readSmallJson(req, maxBytes = 4096) {
  let size = 0; const chunks = [];
  for await (const part of req) {
    size += part.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function api(req, res, url) {
  try {
    if (req.method === 'POST' && !PUBLIC_POSTS.has(url.pathname) && !authorized(req)) return json(res, 401, { error: 'operator token required' });
    if (!runtime.live && !['/api/state', '/api/proof', '/api/auth', '/api/agent/check'].includes(url.pathname)) {
      return json(res, 503, { error: 'Fuse is in setup mode: nothing can execute until the live runtime starts', setup: runtime.setupError });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await runtime.getState());
    if (req.method === 'GET' && url.pathname === '/api/decisions') return json(res, 200, { fuseId: runtime.engine?.fuse?.id, evidence: 'WORKER_LOG_ONLY', decisions: runtime.decisions || [] });
    if (req.method === 'GET' && url.pathname === '/api/proof') return json(res, 200, await runtime.proof());
    if (req.method === 'GET' && url.pathname === '/api/market/context') return json(res, 200, await runtime.marketContext());
    if (req.method === 'GET' && url.pathname === '/api/journal') return json(res, 200, runtime.publicJournal());
    if (req.method === 'POST' && url.pathname === '/api/arm') return json(res, 200, await runtime.arm());
    if (req.method === 'POST' && url.pathname === '/api/kill') return json(res, 200, await runtime.kill());
    if (req.method === 'POST' && url.pathname === '/api/settle') return json(res, 200, await runtime.settle());
    if (req.method === 'POST' && url.pathname === '/api/fuse/new') return json(res, 200, await runtime.newMandate());
    if (req.method === 'POST' && url.pathname === '/api/auth') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/tick') return json(res, 200, await runtime.tick());
    if (req.method === 'GET' && url.pathname === '/api/agent/check') {
      if (!agentCheckLimiter.acquire()) return json(res, 429, { error: 'too many checks; retry in a minute' });
      try {
        const raw = url.searchParams.get('targetUsd');
        const targetUsd = raw == null || raw.trim() === '' ? NaN : Number(raw);
        return json(res, 200, runtime.publicAgentCheck(targetUsd));
      } finally { agentCheckLimiter.release(); }
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/proposal') {
      return json(res, 200, runtime.previewAgentProposal(await readSmallJson(req)));
    }
    if (req.method === 'POST' && url.pathname === '/api/verify') {
      if (!verifyLimiter.acquire()) return json(res, 429, { error: 'verification rate or concurrency limit reached; retry later' });
      try { return json(res, 200, await runtime.verify()); }
      finally { verifyLimiter.release(); }
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const predictConnectOrigins = new Set(['https://api.devnet.solana.com','https://pm-amm-devnet.vercel.app']);
for(const raw of [process.env.VITE_DEVNET_RPC]){
 if(!raw)continue;
 const parsed=new URL(raw);
 if(parsed.protocol!=='https:' || /mainnet/i.test(parsed.hostname))throw Error('Only HTTPS devnet RPC permitted by PREDICT CSP');
 predictConnectOrigins.add(parsed.origin);
}
// web3.js confirms transactions over a websocket to the same RPC host, so allow wss:// for each RPC.
const predictWsOrigins = [...predictConnectOrigins].filter((o) => !o.includes('pm-amm-devnet.vercel.app')).map((o) => o.replace(/^https:/, 'wss:'));
const predictCsp = `default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self' ${[...predictConnectOrigins, ...predictWsOrigins].join(' ')}`;
const perpsCsp = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'";
const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000, connectionsCheckingInterval: 3000 }, async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', req.url?.startsWith('/perps') ? perpsCsp : predictCsp);
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return json(res, 400, { error: 'Invalid request URL' }); }
  // The perps lab lives under /perps/ and calls relative `api/...` and `healthz` paths.
  if (url.pathname === '/perps') { res.writeHead(301, { location: `/perps/${url.search}` }); return res.end(); }
  if (url.pathname.startsWith('/perps/api/') || url.pathname === '/perps/healthz') url.pathname = url.pathname.slice('/perps'.length);
  if (url.pathname === '/healthz') {
    const i = runtime.integrity();
    return json(res, 200, { status: runtime.live ? 'ok' : 'setup', service: 'kult-fuse', version: VERSION, network: i.network, market: runtime.market?.id || null, question: runtime.market?.question || null, onchain: i.onchain, programId: i.programId, perpAdapter: i.perpAdapter, eventSource: i.eventSource, buildTag: i.buildTag, buildSha: i.buildSha, quote: runtime.quoteView(), quoteError: runtime.quoteError || null, time: new Date().toISOString() });
  }
  if (await handlePredictApi(req,res,url)) return;
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  const legacy = url.pathname === '/perps' || url.pathname.startsWith('/perps/');
  const targetRoot = legacy ? webRoot : predictWebRoot;
  let rel = legacy ? url.pathname.slice('/perps'.length) : url.pathname;
  rel = rel === '/' || rel === '' ? '/index.html' : rel;
  if (!path.extname(rel)) rel='/index.html'; // SPA deep links
  const file = path.resolve(targetRoot, '.'+rel);
  if (!file.startsWith(targetRoot + path.sep)) {res.writeHead(403);return res.end('Forbidden');}
  try {
    const data = await fs.readFile(file);
    const immutable = rel.startsWith('/assets/') || rel.startsWith('/fonts/');
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

startPredictReconciler();
server.listen(port, '0.0.0.0', () => {
  console.log(`KULT Fuse running on http://localhost:${port}`);
  console.log(`mode=${runtime.mode} market=${runtime.market?.kind || '-'}:${runtime.market?.id || '-'} perp=${runtime.venueKind()} fuse=${runtime.activeFusePda()}`);
  runtime.startQuoteWatch();
});

// Setup mode retries the live start, so a deployment goes live once its config or RPC recovers.
const retrySec = Number(process.env.SETUP_RETRY_SEC ?? 120);
if (!runtime.live && retrySec > 0) {
  const timer = setInterval(async () => {
    await runtime.start();
    if (runtime.live) { clearInterval(timer); console.log('runtime is live'); }
  }, retrySec * 1000);
  timer.unref();
}

// The live worker polls the market and reconciles the position; disable only for maintenance.
if (String(process.env.AUTO_WORKER || '0') === '1') {
  const ms = Math.max(1000, Number(process.env.AUTO_WORKER_MS || 3000));
  console.log(`auto worker enabled: ${ms}ms`);
  setInterval(async () => {
    try {
      if (!runtime.live) return;
      const status = runtime.engine.fuse.status;
      if (['ARMED','OPEN','REDUCING','KILLED'].includes(status)) await runtime.tick();
    } catch (e) { console.error('auto worker tick failed:', e.message); }
  }, ms).unref();
}

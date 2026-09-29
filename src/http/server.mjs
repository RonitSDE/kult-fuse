import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from './runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const webRoot = path.join(root, 'web');
const port = Number(process.env.PORT || 8787);
const runtime = await new Runtime(process.env).init();

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

// Read-only actions anyone may call; everything else moves money or chain state.
const PUBLIC_POSTS = new Set(['/api/verify']);

async function api(req, res, url) {
  try {
    if (req.method === 'POST' && !PUBLIC_POSTS.has(url.pathname) && !authorized(req)) return json(res, 401, { error: 'operator token required' });
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await runtime.getState());
    if (req.method === 'GET' && url.pathname === '/api/proof') return json(res, 200, runtime.proof());
    if (req.method === 'POST' && url.pathname === '/api/arm') return json(res, 200, await runtime.arm());
    if (req.method === 'POST' && url.pathname === '/api/kill') return json(res, 200, await runtime.kill());
    if (req.method === 'POST' && url.pathname === '/api/settle') return json(res, 200, await runtime.settle());
    if (req.method === 'POST' && url.pathname === '/api/fuse/new') return json(res, 200, await runtime.newMandate());
    if (req.method === 'POST' && url.pathname === '/api/auth') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/tick') return json(res, 200, await runtime.tick());
    if (req.method === 'POST' && url.pathname === '/api/verify') return json(res, 200, await runtime.verify());
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    return json(res, 400, { error: error.message, stack: process.env.NODE_ENV === 'production' ? undefined : error.stack });
  }
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'");
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') {
    const i = runtime.integrity();
    return json(res, 200, { status: 'ok', service: 'kult-fuse', version: '1.2.0', network: i.network, market: runtime.market?.id, onchain: i.onchain, programId: i.programId, perpAdapter: i.perpAdapter, eventSource: i.eventSource, buildTag: i.buildTag, buildSha: i.buildSha, time: new Date().toISOString() });
  }
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  rel = path.normalize(rel).replace(/^\.\.(\/|\\)/g, '');
  const file = path.join(webRoot, rel);
  if (!file.startsWith(webRoot)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`KULT Fuse running on http://localhost:${port}`);
  console.log(`market=${runtime.market.kind}:${runtime.market.id} perp=${process.env.PERP_ADAPTER || 'flash'} fuse=${runtime.activeFusePda()}`);
});

// The live worker polls the market and reconciles the position; disable only for maintenance.
if (String(process.env.AUTO_WORKER || '1') === '1') {
  const ms = Math.max(1000, Number(process.env.AUTO_WORKER_MS || 3000));
  console.log(`auto worker enabled: ${ms}ms`);
  setInterval(async () => {
    try {
      const status = runtime.engine.fuse.status;
      if (['ARMED','OPEN','REDUCING'].includes(status)) await runtime.tick();
    } catch (e) { console.error('auto worker tick failed:', e.message); }
  }, ms).unref();
}

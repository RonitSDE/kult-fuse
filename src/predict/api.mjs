import { readFile, stat } from 'node:fs/promises';
import { createDefaultPredictRegistry, predictPublicConfig } from './registry.mjs';
import { isBase58 } from './attestation.mjs';
import { createVerifyLimiter } from '../http/verify-limiter.mjs';

const MAX_BODY = 2048;
// Several traders can review and verify at once. Attestation is pure HMAC work (no RPC), so it
// gets the larger allowance; it is the call that blocks a trade when refused.
const verifyLimiter = createVerifyLimiter({ maxPerMinute: 600, maxConcurrent: 6 });
const attestLimiter = createVerifyLimiter({ maxPerMinute: 600, maxConcurrent: 16 });
let registryPromise;

function respond(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json' ||
      Number(req.headers['content-length']) > MAX_BODY || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new Error('Expected a small same-origin JSON request');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new Error('Request body exceeds limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function handlePredictApi(req, res, url) {
  const route = url.pathname;
  if (!route.startsWith('/api/predict/')) return false;
  if (req.method === 'GET' && route === '/api/predict/config') {
    respond(res, 200, predictPublicConfig);
    return true;
  }
  const verify = req.method === 'POST' && route === '/api/predict/verify';
  const attest = req.method === 'POST' && route === '/api/predict/attest';
  const limiter = verify ? verifyLimiter : attest ? attestLimiter : null;
  if (limiter && !limiter.acquire()) {
    res.setHeader('retry-after', '5');
    respond(res, 429, { error: 'Verifier busy. Retry shortly.' });
    return true;
  }
  try {
    let body;
    if (limiter) {
      try { body = await readBody(req); }
      catch { respond(res, 400, { error: 'Invalid JSON request' }); return true; }
    }
    registryPromise ??= createDefaultPredictRegistry().catch(error => {
      registryPromise = null;
      throw error;
    });
    const registry = await registryPromise;
    if (req.method === 'GET' && route === '/api/predict/ready') {
      await registry.ready();
      respond(res, 200, { ready: true, network: 'devnet' });
    } else if (req.method === 'GET' && route === '/api/predict/stats') {
      respond(res, 200, { ...(await registry.stats()), pendingFinality: await registry.pendingCount() });
    } else if (req.method === 'GET' && route === '/api/predict/lifecycle') {
      const file = process.env.PREDICT_LIFECYCLE_FILE;
      const info = file && await stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      const proof = info?.isFile() && info.size < 64_000 ? JSON.parse(await readFile(file, 'utf8')) : null;
      const current = ['kult-fuse-devnet-lifecycle-v1', 'kult-fuse-devnet-lifecycle-v2'].includes(proof?.schema) && proof.network === 'devnet' &&
        proof.programId === predictPublicConfig.programId && predictPublicConfig.buildSha &&
        proof.buildSha === predictPublicConfig.buildSha;
      respond(res, current ? 200 : 404, current ? proof : { error: 'Lifecycle proof pending' });
    } else if (req.method === 'GET' && route.startsWith('/api/predict/receipts/')) {
      const signature = route.slice('/api/predict/receipts/'.length);
      const receipt = isBase58(signature, 64) && await registry.receipt(signature);
      respond(res, receipt ? 200 : 404, receipt || { error: 'No finalized receipt' });
    } else if (attest) {
      try { respond(res, 200, { memo: registry.attest(body) }); }
      catch { respond(res, 400, { error: 'Invalid trade review parameters' }); }
    } else if (verify) {
      const result = await registry.record(body);
      const status = result.verified ? 200 : ['confirmed', 'pending'].includes(result.state) ? 202 : 422;
      respond(res, status, result);
    } else {
      respond(res, 404, { error: 'Unknown PREDICT route' });
    }
  } catch {
    respond(res, 503, { error: 'PREDICT verification temporarily unavailable' });
  } finally {
    limiter?.release();
  }
  return true;
}

// Background finality: swaps queued before finality are finalized by the server, so a trade counts
// even if its tab closed. No-op until the attestation key is configured.
export function startPredictReconciler({ everyMs = Number(process.env.PREDICT_RECONCILE_MS || 10_000) } = {}) {
  if (!/^[a-f0-9]{64}$/i.test(process.env.PREDICT_ATTESTATION_KEY ?? '') || !(everyMs > 0)) return null;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      registryPromise ??= createDefaultPredictRegistry().catch(error => { registryPromise = null; throw error; });
      const result = await (await registryPromise).sweep();
      if (result.finalized) console.log(`predict reconciler: ${result.finalized} swap(s) finalized in the background`);
    } catch { /* RPC outage: queued swaps stay queued */ }
    finally { running = false; }
  }, everyMs);
  timer.unref();
  return timer;
}

// DEV ONLY. Serves the dashboard against synthetic state so the layout can be reviewed without a
// deployment. It never touches a chain, carries no transaction signatures, and is not deployed.
//   node scripts/ui-preview.mjs            live-looking mandate, port 8098
//   PREVIEW=killed node scripts/ui-preview.mjs
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAgentProposal } from '../src/core/agent-proposal.mjs';
import { buildDecisionJournal } from '../src/core/decision-journal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const policy = JSON.parse(await fs.readFile(new URL('../policy.example.json', import.meta.url), 'utf8'));
const mode = process.env.PREVIEW || 'live';
const killed = mode === 'killed';
const now = Date.now();
const p = killed ? 0.31 : 0.655;
const permitted = killed ? 0 : 25;
const actual = killed ? 0 : 24.6;
const receipts = [
  { reason: 'INITIAL_OPEN', observedProbabilityBps: 5300, desiredExposureAfterUsd: 15, actualExposureBeforeUsd: 0, filledExposureAfterUsd: 14.8, hash: 'a1'.repeat(32), anchor: { status: 'PREVIEW' } },
  { reason: 'PROBABILITY_STEP_UP', observedProbabilityBps: 6400, desiredExposureAfterUsd: 25, actualExposureBeforeUsd: 14.8, filledExposureAfterUsd: 24.6, hash: 'b2'.repeat(32), anchor: { status: 'PREVIEW' } },
  ...(killed ? [{ reason: 'KILL_PROBABILITY', observedProbabilityBps: 3100, desiredExposureAfterUsd: 0, actualExposureBeforeUsd: 24.6, filledExposureAfterUsd: 0, hash: 'c3'.repeat(32), anchor: { status: 'PREVIEW' } }] : [])
];
const state = () => ({
  integrity: { onchain: true, mode: 'synthetic', network: 'devnet', perpAdapter: 'velocity', eventSource: 'dflow', buildTag: 'ui-preview', buildSha: 'PREVIEW_SYNTHETIC_DATA', venueAuthority: { bound: false, limitation: 'UI preview with synthetic data. In a deployment this paragraph states the venue-key limitation from the server.' } },
  market: { kind: 'dflow', ticker: 'PREVIEW-TICKER', question: 'Preview market — synthetic data, not a live Kalshi quote', outcome: 'YES', endDateMs: now + 9 * 86400e3 },
  quote: { bid: p - 0.005, ask: p + 0.005, probability: p, spreadBps: Math.round(0.01 / p * 1e4), ageSec: 3, depthUsd: 410, quality: true, qualityReason: 'OK', explain: `${(p * 100).toFixed(1)}% mid, 3s old (max 20s), spread ${Math.round(0.01 / p * 1e4)} bps (max 300): the committed curve permits $${permitted}.` },
  fuse: { id: 'preview', status: killed ? 'KILLED' : 'OPEN', policy, policyHash: 'f0'.repeat(32), desiredExposureUsd: permitted, filledExposureUsd: actual, lastProbabilityBps: Math.round(p * 1e4), lastReasonCode: killed ? 'KILL_PROBABILITY' : 'PROBABILITY_STEP_UP', chainTxs: [] },
  position: { venue: 'VELOCITY', cluster: 'devnet', exposureUsd: actual, markPrice: 142.37, unrealizedPnlUsd: killed ? 0 : -0.18 },
  receipts,
  decisions: [
    { at: now - 40e3, outcome: 'EXECUTED', explanation: 'Probability moved into the 60% band twice in a row; target raised to $25 and filled.', reason: 'PROBABILITY_STEP_UP', targetUsd: 25, venueExposureUsd: 24.6 },
    { at: now - 8e3, outcome: 'HELD', explanation: 'Venue exposure is within $2 of the target. No order.', reason: 'NOOP', targetUsd: permitted, venueExposureUsd: actual, repeatCount: 4 }
  ]
});
const proof = { program: { value: null }, fuseAccount: { value: null }, transactions: {}, verifiedRun: null };
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (b, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (url.pathname === '/api/state') return json(state());
  if (url.pathname === '/api/proof') return json(proof);
  if (url.pathname === '/api/market/context') return json({signalAuthority:'DFLOW_ONLY',dflow:{quote:null,usable:false},kalshi:{status:'DISABLED',comparison:{status:'NOT_COMPARABLE'}}});
  if (url.pathname === '/api/journal') { const st=state(); return json(buildDecisionJournal({fuseId:'preview',decisions:st.decisions.map((d,i)=>({...d,id:`fixture-${i}`,fuseId:'preview'})),receipts:st.receipts.map(r=>({...r,fuseId:'preview'}))})); }
  if (url.pathname === '/api/agent/check') {
    const s = state(); const t = Number(url.searchParams.get('targetUsd'));
    return json({ ...evaluateAgentProposal({ fuse: { ...s.fuse, status: killed ? 'KILLED' : 'ARMED', policy: { ...policy, expiryTs: 4102444800 } }, quote: s.quote, proposal: { targetUsd: t, fuseId: s.fuse.id, policyHash: s.fuse.policyHash, proposedAtMs: Date.now() } }), preview: false });
  }
  if (url.pathname.startsWith('/api/')) return json({ error: 'preview: read-only' }, 503);
  const file = path.join(root, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try { const d = await fs.readFile(file); res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(d); }
  catch { res.writeHead(404); res.end('not found'); }
}).listen(Number(process.env.PORT || 8098), () => console.log(`UI preview (synthetic data) on :${process.env.PORT || 8098}`));

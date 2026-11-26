import test from 'node:test';
import assert from 'node:assert/strict';
import { marketState, accrualScale } from '../src/predict/pricing.mjs';
import { createPredictRegistry } from '../src/predict/registry.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Standalone pm-AMM price: Φ((y − x) / L), the same formula as @pm-amm/sdk/math priceFromReserves.
const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const math = { i80f48ToNumber: Number, priceFromReserves: (x, y, L) => Phi((y - x) / L) };

test('pricing: reserves stored at the last accrual give the same price after time passes', () => {
  const endTs = 1_800_003_600, last = 1_800_000_000, lZero = 10;
  const lLast = lZero * Math.sqrt(endTs - last);
  // Reserves consistent with a 62% YES price at the last accrual: u = Φ⁻¹(0.62) ≈ 0.3055 → y − x = u·L.
  const u = 0.30548;
  const m = { endTs, lastAccrualTs: last, lZero, reserveYes: 100, reserveNo: 100 + u * lLast };
  const atLast = marketState(m, math, last).price;
  const later = marketState(m, math, last + 3000).price; // 50 minutes later, no trades
  assert.ok(Math.abs(atLast - 0.62) < 0.002);
  assert.ok(Math.abs(later - atLast) < 1e-9, `price must not drift with time alone (got ${later})`);
  // What v2.0.1 computed: stored reserves against L_eff(now). 62% shows as ~77%.
  const v201 = math.priceFromReserves(m.reserveYes, m.reserveNo, lZero * Math.sqrt(endTs - (last + 3000)));
  assert.ok(v201 > 0.75, `v2.0.1 drift reproduced: ${v201.toFixed(3)}`);
});

test('pricing: scale is 1 at the accrual time and never grows reserves', () => {
  assert.equal(accrualScale(1000, 400, 400).scale, 1);
  assert.equal(accrualScale(1000, 400, 300).scale, 1, 'a clock behind the last accrual does not inflate reserves');
  assert.ok(Math.abs(accrualScale(1000, 0, 750).scale - 0.5) < 1e-12);
});

test('registry retries a just-confirmed signature the RPC has not served yet', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reg-'));
  try {
    let calls = 0;
    const r = createPredictRegistry({
      storePath: path.join(dir, 'r.json'), retryDelaysMs: [0, 1, 1, 1],
      lookup: async () => { calls += 1; return calls < 3 ? null : { meta: { err: 'stop-here' } }; },
      resolveMarketMints: async () => ({ yes: 'Y'.repeat(40), no: 'N'.repeat(40) })
    });
    const out = await r.record({ signature: '5'.repeat(88), wallet: 'W'.repeat(44), marketPda: 'M'.repeat(44) });
    assert.equal(calls, 3, 'kept looking until the RPC returned the transaction');
    assert.equal(out.verified, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('v2.1.3: exact sell inverts a buy on the pm-AMM curve, and matches the SDK buy estimate', async () => {
  const { sellGross, sellQuote } = await import('../src/predict/pricing.mjs');
  const phi = (z) => Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  const m = { phi, capitalPhi: Phi };
  const g = (u) => u * Phi(u) + phi(u);
  const L = 50e6, u0 = 0.2;
  const x = L * (g(u0) - u0), y = L * g(u0);                     // on the curve, YES = Φ(0.2) ≈ 57.9%
  // Buy YES with d net USDC: d pairs are minted (x+d, y+d), then the pool pays out YES until the
  // invariant holds again: y1 = y + d = L·g(u1), x1 = L·(g(u1) − u1), tokens = x + d − x1.
  const d = 10e6, y1 = y + d;
  let lo = -10, hi = 10;
  for (let i = 0; i < 200; i += 1) { const mid = (lo + hi) / 2; if (L * g(mid) < y1) lo = mid; else hi = mid; }
  const u1 = lo, x1 = L * (g(u1) - u1), tokens = x + d - x1;
  assert.ok(Phi(u1) > Phi(u0), 'buying YES raises its price');
  assert.ok(d / tokens > Phi(u0) && d / tokens < Phi(u1), 'average buy price sits between the before and after prices');
  const back = sellGross({ x: x1, y: y1, lEff: L }, tokens, 'yes', m);
  assert.ok(Math.abs(back - d) < 1, `selling the bought tokens returns the USDC (got ${back}, want ${d})`);
  // Cross-check the buy against the real SDK estimate when the app's dependencies are installed.
  try {
    const { createRequire } = await import('node:module');
    const sdkMath = createRequire(new URL('../apps/predict/package.json', import.meta.url))('@pm-amm/sdk/math');
    const est = sdkMath.estimateSwapOutput(x, y, L, d, 'yes');
    assert.ok(Math.abs(est.output - tokens) / tokens < 1e-4, `SDK buy ${est.output} vs curve ${tokens}`);
    const sdkSell = sellGross({ x: x1, y: y1, lEff: L }, est.output, 'yes', { phi: sdkMath.phi, capitalPhi: sdkMath.capitalPhi });
    assert.ok(Math.abs(sdkSell - d) / d < 1e-4, 'round trip with the SDK\'s own Φ and φ');
  } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  const mirror = { x: y, y: x, lEff: L };
  assert.ok(Math.abs(sellGross({ x, y, lEff: L }, 5e6, 'no', m) - sellGross(mirror, 5e6, 'yes', m)) < 1e-3, 'NO mirrors YES');
  const q = sellQuote({ x, y, lEff: L }, 'yes', 5e6, m);
  assert.equal(q.feeRaw, Math.floor(q.grossRaw * 0.02));
  assert.equal(q.netRaw + q.feeRaw, q.grossRaw);
});

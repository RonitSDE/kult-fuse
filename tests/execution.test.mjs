import test from 'node:test';
import assert from 'node:assert/strict';
import { policyHash } from '../src/core/policy.mjs';
import { testPolicy } from './fixtures/policy.mjs';
import { initialFuse } from '../src/core/state.mjs';
import { ManualEventSource } from './fixtures/manual-event.mjs';
import { PaperPerpAdapter } from './fixtures/paper-perp.mjs';
import { FuseEngine } from '../src/worker/fuse-engine.mjs';
import { verifyExecution } from '../src/core/verifier.mjs';
import { makeProbabilityMark, explainSignal } from '../src/core/probability.mjs';

const SIG = (n) => String(n).repeat(88).slice(0, 88);

function fixture({ chainHooks = null } = {}) {
  const policy = testPolicy();
  const fuse = initialFuse({ id: 'exec', policy, policyHash: policyHash(policy) });
  const event = new ManualEventSource({ initialProbability: 0.61, spread: 0.02 });
  const perp = new PaperPerpAdapter({ initialPrice: 150 });
  const receipts = [];
  const engine = new FuseEngine({ fuse, eventSource: event, perpAdapter: perp, appendReceipt: async (r) => receipts.push(r), chainHooks });
  return { policy, fuse, event, perp, receipts, engine };
}

test('loss stop: a controlled losing position closes at the trigger and records evidence', async () => {
  const x = fixture();
  await x.engine.arm();
  await x.engine.tick(); await x.engine.tick();
  assert.equal(Math.round((await x.perp.getPosition()).exposureUsd), 300);

  x.perp.setMarkPrice(120); // -20% on $300 ≈ -$60, past the -$50 trigger
  const out = await x.engine.tick();
  assert.equal(x.fuse.status, 'KILLED');
  assert.equal((await x.perp.getPosition()).exposureUsd, 0);
  assert.ok(x.fuse.lossStop.triggerPnlUsd <= -50);
  assert.equal(x.fuse.lossStop.thresholdUsd, -50);
  assert.equal(x.fuse.lossStop.residualUsd, 0);
  assert.equal(x.fuse.lossStop.closeReceiptHash, x.receipts.at(-1).hash);
  assert.equal(x.receipts.at(-1).reason, 'LOSS_STOP');
  assert.ok(out.lossStop);

  // After the stop the mandate is absorbing: no reopen even at a high probability.
  x.event.setProbability(0.85);
  await x.engine.tick();
  assert.equal((await x.perp.getPosition()).exposureUsd, 0);
});

test('loss stop fires even when the quote is stale', async () => {
  const x = fixture();
  await x.engine.arm();
  await x.engine.tick(); await x.engine.tick();
  x.perp.setMarkPrice(120);
  await x.engine.tick({ bid: 0.8, ask: 0.81, observedAtMs: Date.now() - 60_000, sequence: 99, source: 'test' });
  assert.equal(x.fuse.status, 'KILLED');
  assert.equal((await x.perp.getPosition()).exposureUsd, 0);
});

test('verifier: zero fills shows "No execution to verify", never a pass', async () => {
  const x = fixture();
  const v = await verifyExecution({ fuse: x.engine.snapshot(), receipts: [], chain: { txStatus: async () => ({ confirmed: true }), receiptHead: async () => null } });
  assert.equal(v.status, 'NO_EXECUTION');
  assert.equal(v.summary, 'No execution to verify');
  assert.equal(v.ok, false);
});

function chainHooks({ failAnchor = false } = {}) {
  let n = 0; let head = null;
  return {
    head: () => head,
    hooks: {
      arm: async () => SIG(1),
      acceptObservation: async () => SIG(2),
      setTarget: async () => SIG(3),
      killProbability: async () => SIG(4),
      killAuthorized: async () => SIG(4),
      recordFill: async ({ receiptHash }) => { if (failAnchor) throw new Error('rpc timeout'); head = receiptHash; n += 1; return SIG(5 + (n % 4)); }
    }
  };
}

// Paper fills have no Solana signature; give them real-looking ones so the chain checks decide.
function solanaFills(perp) {
  const exec = perp.executeTarget.bind(perp);
  let i = 0;
  perp.executeTarget = async (...a) => { const r = await exec(...a); if (r.txSignature) r.txSignature = SIG('ABCDEFGH'[i++ % 8]); return r; };
}

test('verifier: fills confirmed and anchored onchain are Verified', async () => {
  const c = chainHooks();
  const x = fixture({ chainHooks: c.hooks });
  solanaFills(x.perp);
  await x.engine.arm();
  await x.engine.tick(); await x.engine.tick();           // open
  x.event.setProbability(0.72); await x.engine.tick(); await x.engine.tick(); // resize
  await x.engine.kill();                                  // close
  const v = await verifyExecution({ fuse: x.engine.snapshot(), receipts: x.receipts, chain: { txStatus: async () => ({ confirmed: true, err: null }), receiptHead: async () => c.head() } });
  assert.equal(v.status, 'VERIFIED', JSON.stringify(v.checks.filter((k) => !k.ok)));
  assert.equal(v.fills.length, 3);
  assert.ok(v.fills.every((f) => f.status === 'VERIFIED' && f.residualUsd != null && f.fuseStatus));
  assert.equal(v.fills.at(-1).positionUsd, 0);
});

test('verifier: an anchoring failure is Unverified, never a pass', async () => {
  const c = chainHooks({ failAnchor: true });
  const x = fixture({ chainHooks: c.hooks });
  solanaFills(x.perp);
  await x.engine.arm();
  await x.engine.tick(); await x.engine.tick();
  assert.equal(x.receipts.at(-1).anchor.status, 'FAILED');
  const v = await verifyExecution({ fuse: x.engine.snapshot(), receipts: x.receipts, chain: { txStatus: async () => ({ confirmed: true, err: null }), receiptHead: async () => c.head() } });
  assert.equal(v.status, 'UNVERIFIED');
  assert.equal(v.ok, false);
  assert.match(v.fills[0].problems.join(), /anchoring failed/);
});

test('verifier: a venue transaction that failed onchain is Unverified', async () => {
  const c = chainHooks();
  const x = fixture({ chainHooks: c.hooks });
  solanaFills(x.perp);
  await x.engine.arm();
  await x.engine.tick(); await x.engine.tick();
  const venueSig = x.receipts[0].txSignature;
  const v = await verifyExecution({ fuse: x.engine.snapshot(), receipts: x.receipts, chain: { txStatus: async (s) => (s === venueSig ? { confirmed: true, err: { InstructionError: [0, 'Custom'] } } : { confirmed: true, err: null }), receiptHead: async () => c.head() } });
  assert.equal(v.status, 'UNVERIFIED');
  assert.match(v.fills[0].problems.join(), /venue tx transaction failed/);
});

test('thin or stale quotes give no increase and explain why', async () => {
  const policy = { ...testPolicy(), minTopDepthUsd: 100 };
  const thin = makeProbabilityMark({ bid: 0.6, ask: 0.61, bidDepthUsd: 20, askDepthUsd: 500 }, policy);
  assert.equal(thin.qualityReason, 'THIN');
  assert.match(explainSignal(thin, policy, 200), /No increase/);
  const stale = makeProbabilityMark({ bid: 0.6, ask: 0.61, observedAtMs: Date.now() - 60_000 }, policy);
  assert.equal(stale.qualityReason, 'STALE');
  const ok = makeProbabilityMark({ bid: 0.6, ask: 0.61, bidDepthUsd: 500, askDepthUsd: 500 }, policy);
  assert.match(explainSignal(ok, policy, 200), /permits \$300/);

  const x = fixture();
  x.fuse.policy.minTopDepthUsd = 100;
  await x.engine.arm();
  const out = await x.engine.tick({ bid: 0.8, ask: 0.81, bidDepthUsd: 5, askDepthUsd: 5, observedAtMs: Date.now(), sequence: 1, source: 'test' });
  assert.equal(out.reason, 'ORACLE_THIN');
  assert.equal((await x.perp.getPosition()).exposureUsd, 0);
});

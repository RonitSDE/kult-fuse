import test from 'node:test';
import assert from 'node:assert/strict';
import { DFlowEventSource } from '../src/adapters/event/dflow-event.mjs';
import { makeProbabilityMark } from '../src/core/probability.mjs';
import { policyHash } from '../src/core/policy.mjs';
import { testPolicy } from './fixtures/policy.mjs';
import { initialFuse } from '../src/core/state.mjs';
import { ManualEventSource } from './fixtures/manual-event.mjs';
import { PaperPerpAdapter } from './fixtures/paper-perp.mjs';
import { FuseEngine } from '../src/worker/fuse-engine.mjs';

const mint = 'YesMint1111111111111111111111111111111111111';
const market = { status: 'active', ticker: 'DEMO', title: 'Fixture', accounts: { usdc: { yesMint: mint } }, yesBid: 0.6, yesAsk: 0.62 };
const book = (sequence) => ({ sequence, yes_bids: { '0.60': 1000 }, no_bids: { '0.38': 1000 } });
function feed(books, opts = {}) {
  let i = 0;
  return new DFlowEventSource({ marketMint: mint, ...opts, fetchImpl: async (url) => ({ ok: true, json: async () => (url.includes('market/by-mint') ? market : books[Math.min(i++, books.length - 1)]) }) });
}

test('a live but quiet book stays fresh: age is fetch time, not time since the last change', async () => {
  const src = feed([book(10), book(11), book(11), book(11)]);
  const policy = testPolicy();
  await src.read(); const moved = await src.read();
  assert.equal(moved.freshnessProven, true);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 60_000; // a minute of no book changes
    const quiet = await src.read();
    assert.equal(quiet.freshnessBasis, 'BOOK_SEQUENCE_UNCHANGED');
    assert.equal(quiet.freshnessProven, true);
    assert.equal(makeProbabilityMark(quiet, policy, Date.now()).qualityReason === 'STALE', false, 'v1.8 marked this STALE after 20s');
  } finally { Date.now = realNow; }
});

test('a feed idle past the liveness window fails closed', async () => {
  const src = feed([book(10), book(11), book(11)], { maxIdleSec: 30 });
  await src.read(); await src.read();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31_000;
    const idle = await src.read();
    assert.equal(idle.freshnessProven, false);
    assert.equal(idle.freshnessBasis, 'BOOK_IDLE_TOO_LONG');
    assert.equal(makeProbabilityMark(idle, testPolicy()).qualityReason, 'UNVERIFIED');
  } finally { Date.now = realNow; }
});

test('a sequence that goes backwards is distrusted until it advances again', async () => {
  const src = feed([book(10), book(11), book(4), book(5)]);
  await src.read(); await src.read();
  const back = await src.read();
  assert.equal(back.freshnessProven, false);
  assert.equal(back.freshnessBasis, 'BOOK_SEQUENCE_WENT_BACKWARDS');
  assert.equal((await src.read()).freshnessProven, true);
});

test('missing venue P&L blocks increases but never blocks a probability kill', async () => {
  const policy = testPolicy();
  const fuse = initialFuse({ id: 'pnl', policy, policyHash: policyHash(policy) });
  const event = new ManualEventSource({ initialProbability: 0.61, spread: 0.02 });
  const perp = new PaperPerpAdapter({ initialPrice: 150 });
  const engine = new FuseEngine({ fuse, eventSource: event, perpAdapter: perp, persist: async () => {}, appendReceipt: async () => {} });
  await engine.arm();
  await engine.tick(); await engine.tick();
  const opened = (await perp.getPosition()).exposureUsd;
  assert.ok(opened > 0);
  const real = perp.getPosition.bind(perp);
  perp.getPosition = async () => ({ ...(await real()), unrealizedPnlUsd: null });
  event.setProbability(0.32);
  await engine.tick();
  assert.equal(fuse.status, 'KILLED', 'v1.8 skipped the tick and left the position open');
  assert.equal(Math.round((await real()).exposureUsd), 0);
});

test('public agent check works in setup mode against the committed curve and never trades', async () => {
  const { Runtime } = await import('../src/http/runtime.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const rt = await new Runtime({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ask-')), POLICY_FILE: './policy.example.json' }).start();
  assert.equal(rt.live, false);
  const noQuote = rt.publicAgentCheck(10);
  assert.equal(noQuote.verdict, 'REFUSE');
  assert.ok(noQuote.reasons.includes('UNTRUSTED_OR_STALE_QUOTE'));
  assert.equal(noQuote.preview, true);
  assert.equal(noQuote.venueTrade, false);
  rt.quote = { raw: { bid: 0.64, ask: 0.65, bidDepthUsd: 500, askDepthUsd: 500, observedAtMs: Date.now(), sequence: 9, source: 'dflow:T' }, source: 'dflow:T' };
  assert.equal(rt.publicAgentCheck(25).verdict, 'ALLOW_AS_PROPOSAL_ONLY');
  const over = rt.publicAgentCheck(50);
  assert.equal(over.verdict, 'REFUSE');
  assert.ok(over.reasons.includes('RISK_CAP_EXCEEDED'));
  assert.ok(rt.publicAgentCheck(Number.NaN).reasons.includes('INVALID_TARGET'));
});

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
import { assertCollateralizedIncrease } from '../src/core/venue-risk.mjs';
import { evaluateAgentProposal } from '../src/core/agent-proposal.mjs';
import { createVerifyLimiter } from '../src/http/verify-limiter.mjs';

const marketMint = 'YesMint1111111111111111111111111111111111111';
const market = { status: 'active', ticker: 'DEMO', title: 'Fixture', accounts: { usdc: { yesMint: marketMint } }, yesBid: 0.40, yesAsk: 0.44 };
const book = (sequence) => ({ sequence, yes_bids: { '0.40': 1000 }, no_bids: { '0.56': 1000 } });
const source = (books) => {
  let i = 0;
  return new DFlowEventSource({ marketMint, fetchImpl: async (url) => {
    const value = url.includes('market/by-mint') ? market : books[Math.min(i++, books.length-1)];
    return value == null ? { ok: false, status: 503, text: async()=> 'unavailable' } : { ok: true, json: async()=>value };
  } });
};
function fixture(eventSource) {
  const policy = testPolicy();
  const fuse = initialFuse({ id:'security-fixture',policy,policyHash:policyHash(policy) });
  const perp = new PaperPerpAdapter({ initialPrice: 100 });
  const engine = new FuseEngine({ fuse, eventSource: eventSource || new ManualEventSource(), perpAdapter:perp });
  return {fuse,perp,engine};
}

test('DFlow unchanged upstream sequence cannot create new confirmation evidence', async () => {
  const dflow = source([book(11), book(11), book(12)]);
  const a=await dflow.read(); const b=await dflow.read(); const c=await dflow.read();
  assert.equal(a.sequence,11); assert.equal(b.sequence,11); assert.equal(c.sequence,12);
  assert.equal(a.observedAtMs,null); assert.equal(b.observedAtMs,null);
  assert.equal(a.freshnessBasis,'AWAITING_FIRST_BOOK_UPDATE');
  assert.equal(a.freshnessProven,false,'first snapshot age cannot be established');
  assert.equal(b.freshnessProven,false);
  assert.equal(c.freshnessProven,true,'only a source advance establishes freshness');
});

test('DFlow metadata fallback is unverified rather than silently fresh', async () => {
  const dflow=source([null]);
  const q=await dflow.read();
  assert.equal(q.sequence,null);
  assert.equal(q.freshnessProven,false);
  assert.equal(q.observedAtMs,null);
  assert.equal(makeProbabilityMark(q, testPolicy()).qualityReason,'UNVERIFIED');
});

test('DFlow book without sequence fails closed even with usable price and liquidity', async () => {
  const dflow=source([book(undefined)]);
  const q=await dflow.read();
  assert.equal(q.freshnessProven,false);
  assert.equal(q.bid,0.4);
});

test('engine refuses risk increase on DFlow fallback but allows emergency kill', async () => {
  const dflow=source([null]);
  const x=fixture(dflow);
  await x.engine.arm();
  const out=await x.engine.tick();
  assert.equal(out.reason,'ORACLE_UNVERIFIED');
  assert.equal(x.fuse.oracleSequence,0);
  assert.equal((await x.perp.getPosition()).exposureUsd,0);
  await x.engine.kill();
  assert.equal(x.fuse.status,'KILLED');
});

test('engine needs a source advance, then holds on a repeated DFlow sequence', async () => {
  const x=fixture(source([book(41),book(42),book(42)]));
  await x.engine.arm();
  const first=await x.engine.tick();
  assert.equal(first.reason,'ORACLE_UNVERIFIED');
  const second=await x.engine.tick();
  assert.equal(second.reason,'AWAITING_CONFIRMATION');
  const third=await x.engine.tick();
  assert.equal(third.reason,'ORACLE_UNCHANGED','same book is the same observation: no confirmation, no error');
  assert.equal(x.fuse.desiredExposureUsd,0);
});

test('oracle rejects future and missing source time', () => {
  const policy=testPolicy();
  const raw={bid:.6,ask:.62,sequence:1};
  assert.equal(makeProbabilityMark({...raw,observedAtMs:Date.now()+60000},policy).qualityReason,'FUTURE');
  assert.equal(makeProbabilityMark({...raw,observedAtMs:null},policy).qualityReason,'UNVERIFIED');
});

test('operational leverage check refuses excess targets or missing collateral', () => {
  assert.equal(assertCollateralizedIncrease({desiredExposureUsd:30,collateralUsd:20,maxLeverageBps:20000}).permittedUsd,40);
  assert.throws(()=>assertCollateralizedIncrease({desiredExposureUsd:41,collateralUsd:20,maxLeverageBps:20000}),/LEVERAGE_LIMIT/);
  assert.throws(()=>assertCollateralizedIncrease({desiredExposureUsd:1,collateralUsd:0,maxLeverageBps:20000}),/COLLATERAL_UNAVAILABLE/);
  assert.throws(()=>assertCollateralizedIncrease({desiredExposureUsd:1,collateralUsd:NaN,maxLeverageBps:20000}),/COLLATERAL_UNAVAILABLE/);
});

test('reconciliation checks venue collateral before an increase, not on close', async () => {
  const x=fixture();
  let seen=0;
  x.perp.assertRiskIncrease=async()=>{seen++;throw new Error('LEVERAGE_LIMIT');};
  await x.engine.arm();
  await x.engine.tick();
  await assert.rejects(()=>x.engine.tick(),/LEVERAGE_LIMIT/);
  assert.equal(seen,1);
  assert.equal((await x.perp.getPosition()).exposureUsd,0);
  // No collateral needed for a zero-risk terminal close.
  await x.engine.kill();
  assert.equal(seen,1);
});

function proposedFixture() {
  const policy=testPolicy(); const fuse=initialFuse({id:'fuse-agent',policy,policyHash:policyHash(policy)});
  fuse.status='ARMED'; const nowMs=Date.now();
  const quote={probability:.61,quality:true};
  const p=(targetUsd)=>({targetUsd,policyHash:fuse.policyHash,fuseId:fuse.id,proposedAtMs:nowMs});
  return {fuse,quote,p,nowMs};
}
test('agent proposal accepts permitted intent but never authorizes a trade',()=>{
  const x=proposedFixture();
  const out=evaluateAgentProposal({...x,proposal:x.p(25)});
  assert.equal(out.verdict,'ALLOW_AS_PROPOSAL_ONLY');
  assert.equal(out.status,'NOT_EXECUTED');
  assert.equal(out.onchainAuthorization,false);
  assert.equal(out.venueTrade,false);
});
test('agent proposal rejects a target beyond curve and cap',()=>{
  const x=proposedFixture();
  const out=evaluateAgentProposal({...x,proposal:x.p(1000)});
  assert.equal(out.verdict,'REFUSE');
  assert.deepEqual(out.reasons.sort(),['CURVE_LIMIT_EXCEEDED','RISK_CAP_EXCEEDED'].sort());
});
test('agent proposal cannot be replayed across mandates',()=>{
  const x=proposedFixture();
  const p=x.p(10);p.fuseId='other';
  assert.ok(evaluateAgentProposal({...x,proposal:p}).reasons.includes('PROPOSAL_BINDING_MISMATCH'));
});
test('agent proposal cannot execute using a stale quote or expired proposal',()=>{
  const x=proposedFixture();
  const a=evaluateAgentProposal({...x,quote:{quality:false,probability:.9},proposal:x.p(10)});
  assert.ok(a.reasons.includes('UNTRUSTED_OR_STALE_QUOTE'));
  const p=x.p(10);p.proposedAtMs=x.nowMs-200000;
  assert.ok(evaluateAgentProposal({...x,proposal:p}).reasons.includes('EXPIRED_OR_FUTURE_PROPOSAL'));
});
test('killed or expired mandate refuses agent proposals even for $0',()=>{
  const x=proposedFixture();x.fuse.status='KILLED';
  assert.ok(evaluateAgentProposal({...x,proposal:x.p(0)}).reasons.includes('MANDATE_NOT_ACTIVE'));
  x.fuse.status='ARMED';x.fuse.policy.expiryTs=Math.floor(x.nowMs/1000)-1;
  assert.ok(evaluateAgentProposal({...x,proposal:x.p(0)}).reasons.includes('MANDATE_EXPIRED'));
});
test('public verifier global rate limit defeats forged client IP rotation',()=>{
  let t=0; const l=createVerifyLimiter({maxPerMinute:3,windowMs:1000,clock:()=>t});
  assert.equal(l.acquire(),true);
  assert.equal(l.acquire(),false,'cannot start concurrent verification');
  l.release();
  for(let i=0;i<2;i++){assert.equal(l.acquire(),true);l.release();}
  for(let i=0;i<100;i++) assert.equal(l.acquire(),false,'request headers cannot reset global budget');
  t=1001; assert.equal(l.acquire(),true);
});

test('unknown venue P&L halts new risk with an active loss stop', async()=>{
  const x=fixture();
  const getPosition=x.perp.getPosition.bind(x.perp);
  x.perp.getPosition=async()=>({...await getPosition(),unrealizedPnlUsd:null});
  await x.engine.arm();
  await x.engine.tick(); // first observation of a new band awaits confirmation
  const result=await x.engine.tick();
  assert.equal(result.reason,'VENUE_PNL_UNAVAILABLE');
  assert.equal((await x.perp.getPosition()).exposureUsd,0);
  // Emergency close remains available despite the missing risk feed.
  await x.engine.kill();
  assert.equal(x.fuse.status,'KILLED');
});

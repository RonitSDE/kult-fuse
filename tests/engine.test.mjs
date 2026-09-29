import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDemoPolicy, policyHash } from '../src/core/policy.mjs';
import { initialFuse } from '../src/core/state.mjs';
import { ManualEventSource } from '../src/adapters/event/manual-event.mjs';
import { PaperPerpAdapter } from '../src/adapters/perp/paper-perp.mjs';
import { FuseEngine } from '../src/worker/fuse-engine.mjs';
import { verifyReceiptChain } from '../src/core/receipt.mjs';

function fixture() {
  const policy=defaultDemoPolicy();
  const fuse=initialFuse({id:'test',policy,policyHash:policyHash(policy)});
  const event=new ManualEventSource({initialProbability:.61,spread:.02});
  const perp=new PaperPerpAdapter({initialPrice:150});
  const receipts=[];
  const engine=new FuseEngine({fuse,eventSource:event,perpAdapter:perp,persist:async()=>{},appendReceipt:async r=>receipts.push(r)});
  return {policy,fuse,event,perp,receipts,engine};
}

async function twoTicks(engine) { await engine.tick(); return engine.tick(); }

test('clean path arms, opens, resizes, reduces, kills', async()=>{
  const x=fixture();
  await x.engine.arm();
  await twoTicks(x.engine); // 61 => 300 after confirmation
  assert.equal(Math.round((await x.perp.getPosition()).exposureUsd),300);

  x.event.setProbability(.72); await twoTicks(x.engine);
  assert.equal(Math.round((await x.perp.getPosition()).exposureUsd),420);

  x.event.setProbability(.54); await twoTicks(x.engine);
  assert.equal(Math.round((await x.perp.getPosition()).exposureUsd),200);

  x.event.setProbability(.32); await x.engine.tick(); // kill bypasses confirmation
  assert.equal(x.fuse.status,'KILLED');
  assert.equal(Math.round((await x.perp.getPosition()).exposureUsd),0);

  x.event.setProbability(.80);
  const out=await x.engine.tick();
  assert.equal(out.skipped,true);
  assert.equal(Math.round((await x.perp.getPosition()).exposureUsd),0);
});

test('oracle replay rejected', async()=>{
  const x=fixture(); await x.engine.arm();
  const o={bid:.60,ask:.62,observedAtMs:Date.now(),sequence:1,source:'test'};
  await x.engine.tick(o);
  await assert.rejects(()=>x.engine.tick(o),/oracle replay/);
});

test('stale oracle does not increase risk', async()=>{
  const x=fixture(); await x.engine.arm();
  const out=await x.engine.tick({bid:.80,ask:.81,observedAtMs:Date.now()-60000,sequence:1,source:'test'});
  assert.equal(out.skipped,true);
  assert.equal((await x.perp.getPosition()).exposureUsd,0);
});

test('reconciliation uses venue actual position, preventing double execution', async()=>{
  const x=fixture(); await x.engine.arm();
  x.fuse.desiredExposureUsd=300;
  x.fuse.pendingExecutionNonce=1;x.fuse.executionNonce=1;x.fuse.pendingTargetExposureUsd=300;
  // Simulate the external order landed before local/onchain receipt was recorded.
  await x.perp.executeTarget(300,{clientOrderId:'landed-before-crash'});
  const out=await x.engine.reconcile({force:false});
  assert.equal(out.executed,false);
  assert.equal(Math.round((await x.perp.getPosition()).exposureUsd),300);
});

test('manual emergency kill is absorbing and closes exposure', async()=>{
  const x=fixture(); await x.engine.arm(); await twoTicks(x.engine);
  assert.equal(Math.round((await x.perp.getPosition()).exposureUsd),300);
  await x.engine.kill();
  assert.equal(x.fuse.status,'KILLED');
  assert.equal(x.fuse.lastReasonCode,'EMERGENCY_KILL');
  assert.equal(Math.round((await x.perp.getPosition()).exposureUsd),0);
});

test('onchain signatures are attached to receipts without breaking the hash chain', async()=>{
  const policy=defaultDemoPolicy();
  const fuse=initialFuse({id:'chain',policy,policyHash:policyHash(policy)});
  const event=new ManualEventSource({initialProbability:.61,spread:.02});
  const perp=new PaperPerpAdapter({initialPrice:150});
  const receipts=[]; let n=0;
  const sig=async()=>`sig${++n}`;
  const chainHooks={arm:sig,acceptObservation:sig,setTarget:sig,killProbability:sig,killAuthorized:sig,recordFill:sig,settle:sig};
  const engine=new FuseEngine({fuse,eventSource:event,perpAdapter:perp,appendReceipt:async r=>receipts.push(r),chainHooks});
  await engine.arm(); await twoTicks(engine);
  event.setProbability(.30); await engine.tick();
  assert.equal(fuse.status,'KILLED');
  assert.deepEqual(fuse.chainTxs.map(t=>t.ix).slice(0,2),['arm_fuse','accept_observation']);
  assert.ok(fuse.chainTxs.some(t=>t.ix==='trigger_probability_kill'));
  assert.ok(receipts.length>=2);
  for(const r of receipts) assert.equal(r.chain.txs.at(-1).ix,'record_fill');
  assert.equal(verifyReceiptChain(receipts,fuse.policyHash).ok,true);
});

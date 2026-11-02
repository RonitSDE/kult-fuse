import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDecision, retainDecisions } from '../src/core/decision.mjs';
import { Runtime } from '../src/http/runtime.mjs';

const fuse = (status='ARMED', id='fuse-a') => ({
  id, status, lastProbabilityBps:6400, desiredExposureUsd:25,
  filledExposureUsd:0, oracleSequence:2, lastReasonCode:'NOOP'
});
const position = (exposureUsd) => ({ exposureUsd });

test('refusals and no-fill decisions never manufacture a venue receipt', () => {
  for (const reason of ['ORACLE_STALE','ORACLE_WIDE','ORACLE_THIN','AWAITING_CONFIRMATION','NO_VENUE_FILL']) {
    const d=makeDecision({action:'tick',fuse:fuse(),result:{skipped:true,reason},position:position(0)});
    assert.equal(d.outcome,reason==='NO_VENUE_FILL'?'NO_FILL':'HOLD');
    assert.equal(d.venueSignature,null);
    assert.equal(d.receiptHash,null);
    assert.equal(d.evidence,'WORKER_LOG_ONLY');
  }
});

test('chain failure reports a block, not an executed trade', () => {
  const f={...fuse(),chainWarning:'risk increase not committed onchain, will retry'};
  const d=makeDecision({action:'tick',fuse:f,error:new Error('Transaction was not confirmed'),position:position(0)});
  assert.equal(d.outcome,'BLOCKED');
  assert.equal(d.reason,'CHAIN_COMMITMENT_FAILED');
  assert.equal(d.venueSignature,null);
});

test('a killed mandate remains close pending until venue position is observed flat', () => {
  const f=fuse('KILLED');
  const pending=makeDecision({action:'kill',fuse:f,result:{executed:false},position:position(12)});
  assert.equal(pending.outcome,'CLOSE_PENDING');
  assert.equal(pending.venueExposureUsd,12);
  const failed=makeDecision({action:'tick',fuse:f,error:new Error('venue outage'),position:position(12)});
  assert.equal(failed.outcome,'CLOSE_PENDING');
  const unknown=makeDecision({action:'kill',fuse:f,result:{executed:false}});
  assert.equal(unknown.outcome,'CLOSE_UNKNOWN');
  assert.equal(unknown.venueExposureUsd,null);
  const flat=makeDecision({action:'kill',fuse:f,result:{executed:true,exec:{txSignature:'VENUE'},receipt:{hash:'HASH',anchor:{status:'FAILED'}}},position:position(0)});
  assert.equal(flat.outcome,'CLOSED');
  assert.equal(flat.evidence,'WORKER_LOG_ONLY');
  assert.equal(flat.anchorStatus,'FAILED');
});

test('runtime persists bounded decisions for the active mandate', async () => {
  const writes=[];
  const rt=Object.create(Runtime.prototype);
  rt.decisions=[];
  rt.store={write:async (...args)=>writes.push(args)};
  rt.engine={snapshot:()=>fuse()};
  rt.perp={getPosition:async()=>position(0)};
  await rt.recordDecision('tick',async()=>({skipped:true,reason:'ORACLE_STALE'}));
  assert.equal(writes[0][0],'decisions');
  assert.equal(rt.decisions[0].outcome,'HOLD');
  await assert.rejects(()=>rt.recordDecision('tick',async()=>{throw new Error('oracle replay rejected')}),/oracle replay/);
  assert.equal(rt.decisions.at(-1).reason,'ORACLE_REPLAY');
  const another=makeDecision({action:'arm',fuse:fuse('PROPOSED','fuse-b'),position:position(0)});
  assert.deepEqual(retainDecisions(rt.decisions,another,1),[another]);
});

test('repeated holds collapse without hiding changes in exposure', () => {
  const first=makeDecision({action:'tick',fuse:fuse(),result:{reason:'ORACLE_STALE'},position:position(0),at:1000});
  const next=makeDecision({action:'tick',fuse:fuse(),result:{reason:'ORACLE_STALE'},position:position(0),at:2000});
  const repeated=retainDecisions([first],next);
  assert.equal(repeated.length,1);
  assert.equal(repeated[0].repeatCount,2);
  const moved=makeDecision({action:'tick',fuse:fuse(),result:{reason:'ORACLE_STALE'},position:position(12),at:3000});
  assert.equal(retainDecisions(repeated,moved).length,2);
});

test('manual kill waits for an in-flight worker tick; rejected ticks do not poison the queue', async () => {
  const rt = Object.create(Runtime.prototype);
  const events = [];
  let releaseTick;
  rt.recordDecision = async (_action, operation) => operation();
  rt.engine = {
    tick: async () => { events.push('tick start'); await new Promise(resolve => { releaseTick = resolve; }); events.push('tick end'); throw new Error('oracle outage'); },
    kill: async () => { events.push('kill'); return { status: 'KILLED' }; }
  };
  const tick = rt.tick();
  await new Promise(resolve => setImmediate(resolve));
  const kill = rt.kill();
  assert.deepEqual(events, ['tick start']);
  releaseTick();
  await assert.rejects(tick,/oracle outage/);
  assert.deepEqual(await kill, { status: 'KILLED' });
  assert.deepEqual(events, ['tick start','tick end','kill']);
});

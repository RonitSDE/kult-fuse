import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDemoPolicy, hysteresisTarget, policyHash } from '../src/core/policy.mjs';
import { makeProbabilityMark } from '../src/core/probability.mjs';
import { initialFuse } from '../src/core/state.mjs';
import { createReceipt, verifyReceiptChain } from '../src/core/receipt.mjs';
import { verifyFuse } from '../src/core/verifier.mjs';
import { replayPolicy } from '../src/core/replay.mjs';

const policy = defaultDemoPolicy();

test('policy hash is deterministic', () => {
  assert.equal(policyHash(policy), policyHash(JSON.parse(JSON.stringify(policy))));
});

test('probability mark uses midpoint and validates spread', () => {
  const m = makeProbabilityMark({ bid:.60, ask:.62, observedAtMs:Date.now(), sequence:1 }, policy);
  assert.equal(m.pBps, 6100);
  assert.equal(m.quality, true);
});

test('hysteresis blocks 59.5/60.5 chatter around 60% band', () => {
  let target = 200;
  for (const p of [6050,5950,6050,5950,6050,5950]) {
    target = hysteresisTarget(policy, p, target).targetUsd;
    assert.equal(target, 200);
  }
});

test('hysteresis enters next band after 61%', () => {
  assert.equal(hysteresisTarget(policy, 6100, 200).targetUsd, 300);
});

test('kill is absorbing in replay', () => {
  const rows = replayPolicy(policy, [6100,7200,5400,3200,7600]);
  assert.equal(rows[3].status, 'KILLED');
  assert.equal(rows[4].after, 0);
  assert.equal(rows[4].status, 'KILLED');
});

test('receipt chain detects tampering', () => {
  const ph = policyHash(policy);
  const r1 = createReceipt({fuseId:'f',sequence:1,observedProbabilityBps:6100,desiredExposureBeforeUsd:0,desiredExposureAfterUsd:300,actualExposureBeforeUsd:0,filledExposureAfterUsd:300,markPrice:150,reason:'INITIAL_OPEN',venue:'PAPER',policyHash:ph});
  const r2 = createReceipt({fuseId:'f',sequence:2,prevReceiptHash:r1.hash,observedProbabilityBps:7200,desiredExposureBeforeUsd:300,desiredExposureAfterUsd:420,actualExposureBeforeUsd:300,filledExposureAfterUsd:420,markPrice:150,reason:'PROBABILITY_STEP_UP',venue:'PAPER',policyHash:ph});
  assert.equal(verifyReceiptChain([r1,r2],ph).ok,true);
  r2.filledExposureAfterUsd=999;
  assert.equal(verifyReceiptChain([r1,r2],ph).ok,false);
});

test('verifier passes a consistent empty fuse', () => {
  const ph=policyHash(policy);const fuse=initialFuse({id:'f',policy,policyHash:ph});
  assert.equal(verifyFuse({fuse,receipts:[]}).ok,true);
});

test('verifier rejects a hash-valid receipt that violates P → E policy', () => {
  const ph=policyHash(policy); const fuse=initialFuse({id:'f',policy,policyHash:ph});
  const bad=createReceipt({fuseId:'f',sequence:1,observedProbabilityBps:6100,desiredExposureBeforeUsd:0,desiredExposureAfterUsd:500,actualExposureBeforeUsd:0,filledExposureAfterUsd:500,markPrice:150,reason:'INITIAL_OPEN',venue:'PAPER',policyHash:ph});
  fuse.lastReceiptHash=bad.hash; fuse.desiredExposureUsd=500; fuse.filledExposureUsd=500;
  const result=verifyFuse({fuse,receipts:[bad]});
  assert.equal(result.ok,false);
  assert.equal(result.stats.policyViolations,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { proofTransactions } from '../src/http/runtime.mjs';

test('proof links prefer the live fuse over pinned env signatures', () => {
  const txs = proofTransactions({
    env: { PROOF_CREATE_TX: 'pinned-create', PROOF_KILL_TX: 'pinned-kill', PROOF_FLASH_OPEN_TX: 'pinned-open' },
    chain: { createTx: 'live-create' },
    fuse: { chainTxs: [{ ix: 'arm_fuse', signature: 'live-arm' }, { ix: 'set_target', signature: 'live-target' }, { ix: 'trigger_probability_kill', signature: 'live-kill' }] },
    receipts: [
      { reason: 'INITIAL_OPEN', txSignature: 'live-open' },
      { reason: 'PROBABILITY_STEP_UP', txSignature: 'live-resize' },
      { reason: 'KILL_PROBABILITY', txSignature: 'live-close' }
    ]
  });
  assert.equal(txs.create, 'live-create');
  assert.equal(txs.arm, 'live-arm');
  assert.equal(txs.target, 'live-target');
  assert.equal(txs.kill, 'live-kill');
  assert.equal(txs.flashOpen, 'live-open');
  assert.equal(txs.flashResize, 'live-resize');
  assert.equal(txs.flashClose, 'live-close');
});

test('proof links fall back to pinned env signatures when the live log has none', () => {
  const txs = proofTransactions({
    env: { PROOF_FLASH_CLOSE_TX: 'pinned-close' },
    receipts: [{ reason: 'KILL_PROBABILITY', txSignature: null }]
  });
  assert.equal(txs.flashClose, 'pinned-close');
  assert.equal(txs.arm, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { proofTransactions, isSignature } from '../src/http/runtime.mjs';

// Base58 strings of signature length, distinguishable by prefix.
const sig = (name) => name.replaceAll('l', 'L').padEnd(88, 'x');

test('proof links use current mandate transactions and position receipts', () => {
  const txs = proofTransactions({
    chain: { createTx: sig('livecreate') },
    fuse: { chainTxs: [{ ix: 'arm_fuse', signature: sig('livearm') }, { ix: 'set_target', signature: sig('livetarget') }, { ix: 'trigger_probability_kill', signature: sig('livekill') }] },
    receipts: [
      { reason: 'INITIAL_OPEN', txSignature: sig('liveopen') },
      { reason: 'PROBABILITY_STEP_UP', txSignature: sig('liveresize') },
      { reason: 'KILL_PROBABILITY', txSignature: sig('liveclose') }
    ]
  });
  assert.equal(txs.create, sig('livecreate'));
  assert.equal(txs.arm, sig('livearm'));
  assert.equal(txs.target, sig('livetarget'));
  assert.equal(txs.kill, sig('livekill'));
  assert.equal(txs.venueOpen, sig('liveopen'));
  assert.equal(txs.venueResize, sig('liveresize'));
  assert.equal(txs.venueClose, sig('liveclose'));
});

test('no receipts means no venue proof even when old pinned env values exist', () => {
  const txs = proofTransactions({
    env: { PROOF_FLASH_CLOSE_TX: sig('pinnedclose') },
    receipts: [{ reason: 'KILL_PROBABILITY', txSignature: null }]
  });
  assert.equal(txs.venueClose, null);
  assert.equal(txs.arm, null);
});

test('a genuine expiry close is published as venue close proof', () => {
  const txs = proofTransactions({ receipts: [{ reason: 'EXPIRY_CLOSE', txSignature: sig('expiryclose') }] });
  assert.equal(txs.venueClose, sig('expiryclose'));
});

test('proof links drop values that are not Solana signatures', () => {
  const txs = proofTransactions({
    chain: { createTx: 'not-a-signature' },
    receipts: [
      { reason: 'PROBABILITY_STEP_UP', txSignature: 'b7a2cd61ed02f587d3826301834bf96e' },
      { reason: 'KILL_PROBABILITY', txSignature: '44491ec3a34424b3f0151fa92001687c' }
    ]
  });
  assert.equal(txs.create, null);
  assert.equal(txs.venueOpen, null);
  assert.equal(txs.venueResize, null);
  assert.equal(txs.venueClose, null);
  assert.equal(isSignature('57PkkfhowF8eZygC92VKk2ixkSkfRoNBN9wqjD6Xn9eLWvYjoruS16aXKBeEEHqf6Hi8hU4z2gzPLQnkgtdbqSAQ'), true);
});

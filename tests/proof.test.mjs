import test from 'node:test';
import assert from 'node:assert/strict';
import { proofTransactions, isSignature } from '../src/http/runtime.mjs';

// Base58 strings of signature length, distinguishable by their prefix. Base58 has no lowercase l.
const sig = (name) => name.replaceAll('l', 'L').padEnd(88, 'x');

test('proof links prefer the live fuse over pinned env signatures', () => {
  const txs = proofTransactions({
    env: { PROOF_CREATE_TX: sig('pinnedcreate'), PROOF_KILL_TX: sig('pinnedkill'), PROOF_FLASH_OPEN_TX: sig('pinnedopen') },
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
  assert.equal(txs.flashOpen, sig('liveopen'));
  assert.equal(txs.flashResize, sig('liveresize'));
  assert.equal(txs.flashClose, sig('liveclose'));
});

test('proof links fall back to pinned env signatures when the live log has none', () => {
  const txs = proofTransactions({
    env: { PROOF_FLASH_CLOSE_TX: sig('pinnedclose') },
    receipts: [{ reason: 'KILL_PROBABILITY', txSignature: null }]
  });
  assert.equal(txs.flashClose, sig('pinnedclose'));
  assert.equal(txs.arm, null);
});

test('proof links drop values that are not Solana signatures', () => {
  const txs = proofTransactions({
    env: { PROOF_FLASH_OPEN_TX: 'a05cabdd5bdcc5df320e947b2dce9ecb', PROOF_FLASH_CLOSE_TX: sig('pinnedclose') },
    chain: { createTx: 'not-a-signature' },
    receipts: [
      { reason: 'PROBABILITY_STEP_UP', txSignature: 'b7a2cd61ed02f587d3826301834bf96e' },
      { reason: 'KILL_PROBABILITY', txSignature: '44491ec3a34424b3f0151fa92001687c' }
    ]
  });
  assert.equal(txs.create, null);
  assert.equal(txs.flashOpen, null);
  assert.equal(txs.flashResize, null);
  assert.equal(txs.flashClose, sig('pinnedclose'));
  assert.equal(isSignature('57PkkfhowF8eZygC92VKk2ixkSkfRoNBN9wqjD6Xn9eLWvYjoruS16aXKBeEEHqf6Hi8hU4z2gzPLQnkgtdbqSAQ'), true);
});

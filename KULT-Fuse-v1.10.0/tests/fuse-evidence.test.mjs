import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingFillRecord } from '../src/adapters/store/fuse-evidence.mjs';

const hash = 'ab'.repeat(32);
const receipt = { hash, sequence: 8, filledExposureAfterUsd: 25.43 };
const event = { name: 'FillRecorded', data: { fuse: { toBase58: () => 'expected-pda' },
  receiptHash: [...Buffer.from(hash, 'hex')], executionNonce: { toString: () => '8' },
  filledExposureUsd: { toString: () => '25' } } };
test('Fuse anchor matches mandate, receipt hash, execution nonce and filled amount', () => {
  assert.equal(matchingFillRecord([event], { fusePda: 'expected-pda', receipt }), true);
  assert.equal(matchingFillRecord([event], { fusePda: 'other-pda', receipt }), false);
  assert.equal(matchingFillRecord([event], { fusePda: 'expected-pda', receipt: { ...receipt, hash: 'cd'.repeat(32) } }), false);
  assert.equal(matchingFillRecord([event], { fusePda: 'expected-pda', receipt: { ...receipt, sequence: 9 } }), false);
});

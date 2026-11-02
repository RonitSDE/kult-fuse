import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDriftFills, driftVenueEvidence } from '../src/adapters/perp/drift-evidence.mjs';

const user = 'expected-user';
const record = (role, direction, amount) => ({
  name: 'OrderActionRecord', data: {
    action: { fill: {} }, marketType: { perp: {} }, marketIndex: 0,
    baseAssetAmountFilled: { toString: () => String(amount * 1e9) },
    [role]: user, [`${role}OrderDirection`]: { [direction]: {} }
  }
});

test('venue evidence counts only fills on the intended account and perp market', () => {
  const ignored = record('taker', 'long', 8);
  ignored.data.marketIndex = 2;
  const sum = summarizeDriftFills([record('taker', 'long', 0.2), record('maker', 'short', 0.05), ignored], { user, marketIndex: 0 });
  assert.equal(sum.count, 2);
  assert.ok(Math.abs(sum.deltaBase - 0.15) < 1e-9);
});

test('signature alone cannot pass: a transaction without the expected program is rejected before decoding', async () => {
  const result = await driftVenueEvidence({
    connection: { getTransaction: async () => ({ slot: 5, meta: { err: null, logMessages: [] }, transaction: { message: { accountKeys: ['other-program', user] } } }) },
    program: { programId: 'drift-program' }, user, marketIndex: 0, signature: 'signature',
    receipt: { baseAmountBefore: 0, baseAmountAfter: 1 }
  });
  assert.equal(result.ok, false);
  assert.match(result.why, /expected venue program/);
});

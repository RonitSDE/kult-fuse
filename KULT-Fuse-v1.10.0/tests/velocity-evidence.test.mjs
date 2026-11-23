import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeVelocityFills, velocityVenueEvidence } from '../src/adapters/perp/velocity-evidence.mjs';

const user = 'expected-user';
const PROGRAM = 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
// camelCase fields + lowercase variants, as the Velocity SDK coder returns them.
const record = (role, direction, amount) => ({
  name: 'OrderActionRecord', data: {
    action: { fill: {} }, marketType: { perp: {} }, marketIndex: 0,
    baseAssetAmountFilled: { toString: () => String(amount * 1e9) },
    [role]: user, [`${role}OrderDirection`]: { [direction]: {} }
  }
});
// snake_case fields + PascalCase variants, as a raw Anchor 1.0 coder returns them.
const rawRecord = (direction, amount) => ({
  name: 'OrderActionRecord', data: {
    action: { Fill: {} }, market_type: { Perp: {} }, market_index: 0,
    base_asset_amount_filled: String(amount * 1e9), taker: user, taker_order_direction: { [direction]: {} }
  }
});

test('velocity evidence counts only fills on the intended account and perp market', () => {
  const ignored = record('taker', 'long', 8);
  ignored.data.marketIndex = 2;
  const placed = record('taker', 'long', 3);
  placed.data.action = { place: {} };
  const sum = summarizeVelocityFills([record('taker', 'long', 0.2), record('maker', 'short', 0.05), ignored, placed], { user, marketIndex: 0 });
  assert.equal(sum.count, 2);
  assert.ok(Math.abs(sum.deltaBase - 0.15) < 1e-9);
});

test('velocity evidence reads raw Anchor 1.0 casing too', () => {
  const sum = summarizeVelocityFills([rawRecord('Long', 0.4), rawRecord('Short', 0.1)], { user, marketIndex: 0 });
  assert.equal(sum.count, 2);
  assert.ok(Math.abs(sum.deltaBase - 0.3) < 1e-9);
});

const txWith = (keys, logs = ['log']) => ({ getTransaction: async () => ({ slot: 9, meta: { err: null, logMessages: logs }, transaction: { message: { staticAccountKeys: keys } } }) });

test('signature alone cannot pass: a transaction without the Velocity program is rejected before decoding', async () => {
  const result = await velocityVenueEvidence({ connection: txWith(['other-program', user]), parse: () => [record('taker', 'long', 1)], programId: PROGRAM, user, marketIndex: 0, signature: 's', receipt: { baseAmountBefore: 0, baseAmountAfter: 1 } });
  assert.equal(result.ok, false);
  assert.match(result.why, /Velocity program/);
});

test('a decoded fill must match the receipt base delta', async () => {
  const base = { connection: txWith([PROGRAM, user]), parse: () => [record('taker', 'long', 0.5)], programId: PROGRAM, user, marketIndex: 0, signature: 's' };
  assert.equal((await velocityVenueEvidence({ ...base, receipt: { baseAmountBefore: 0, baseAmountAfter: 0.5 } })).ok, true);
  const bad = await velocityVenueEvidence({ ...base, receipt: { baseAmountBefore: 0, baseAmountAfter: 0.9 } });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /receipt delta 0.9/);
});

test('a failed venue transaction is not evidence', async () => {
  const connection = { getTransaction: async () => ({ slot: 1, meta: { err: { InstructionError: [0, 'x'] }, logMessages: [] }, transaction: { message: { staticAccountKeys: [PROGRAM, user] } } }) };
  const r = await velocityVenueEvidence({ connection, parse: () => [], programId: PROGRAM, user, marketIndex: 0, signature: 's', receipt: { baseAmountBefore: 0, baseAmountAfter: 1 } });
  assert.equal(r.ok, false);
});

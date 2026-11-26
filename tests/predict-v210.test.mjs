import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTradeAttestation } from '../src/predict/attestation.mjs';
import { assertDevnet, DEVNET_GENESIS } from '../src/predict/network.mjs';
import { PROGRAM_ID, DEVNET_MUSDC } from '../src/predict/policy.mjs';
import { anchorIx, verifyPredictSwapTx } from '../src/predict/proof.mjs';
import { createPredictRegistry } from '../src/predict/registry.mjs';
import { APP_MEMO, MEMO_PROGRAM_ID } from '../src/predict/tagged-swap.mjs';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let number = BigInt('0x' + bytes.toString('hex'));
  let result = '';
  while (number > 0n) {
    result = alphabet[Number(number % 58n)] + result;
    number /= 58n;
  }
  let leading = 0;
  while (leading < bytes.length && !bytes[leading]) leading++;
  return '1'.repeat(leading) + result;
}

const address = () => base58(randomBytes(32));
const wallet = address(), marketPda = address(), blockhash = address();
const expectedMints = { yes: address(), no: address() };
const signature = base58(randomBytes(64));
const nowSec = Math.floor(Date.now() / 1000);
const intent = { wallet, marketPda, blockhash, side: 'yes', amountRaw: 5_000_000, minOutRaw: 6_000_000 };
const attestation = createTradeAttestation('0a'.repeat(32), () => nowSec);
const memo = attestation.issue(intent);
const options = { signature, wallet, marketPda, expectedMints, attestation, nowSec };

function tx({ tag = memo, hash = blockhash, side = 0, amount = 5_000_000, gain = 6_100_000, debit = 5_000_000,
  txSignature = signature, extra = [] } = {}) {
  const data = Buffer.alloc(25);
  anchorIx('swap').copy(data);
  data[8] = side;
  data.writeBigUInt64LE(BigInt(amount), 9);
  data.writeBigUInt64LE(BigInt(intent.minOutRaw), 17);
  const token = (mint, amount) => ({ owner: wallet, mint, uiTokenAmount: { amount: String(amount) } });
  return {
    slot: 42, blockTime: nowSec,
    transaction: {
      signatures: [txSignature],
      message: {
        recentBlockhash: hash, accountKeys: [{ pubkey: wallet, signer: true }],
        instructions: [
          { programId: PROGRAM_ID, accounts: [wallet, marketPda, DEVNET_MUSDC, expectedMints.yes, expectedMints.no], data: base58(data) },
          { programId: MEMO_PROGRAM_ID, parsed: tag },
          ...extra
        ]
      }
    },
    meta: {
      err: null, preTokenBalances: [token(DEVNET_MUSDC, 10_000_000)],
      postTokenBalances: [token(DEVNET_MUSDC, 10_000_000 - debit), token(expectedMints.yes, gain)]
    }
  };
}

test('strict verifier requires the pinned swap amounts, wallet, side, blockhash and server attestation', () => {
  assert.equal(verifyPredictSwapTx(tx(), options).attribution, 'FUSE_API_ATTESTED');
  for (const change of [{ tag: APP_MEMO }, { hash: address() }, { side: 1 }, { amount: 4_000_000 },
    { gain: 5_999_999 }, { debit: 5_000_001 }, { txSignature: base58(randomBytes(64)) }]) {
    assert.equal(verifyPredictSwapTx(tx(change), options).ok, false);
  }
  assert.equal(attestation.verify(memo, intent, nowSec + 121), false);
  assert.equal(attestation.verify(memo, { ...intent, wallet: address() }, nowSec), false);
});

test('strict verifier excludes auxiliary transfers and duplicate swaps', () => {
  const transaction = tx();
  const ixs = transaction.transaction.message.instructions;
  ixs.push({ programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', parsed: { type: 'transfer' } });
  assert.equal(verifyPredictSwapTx(transaction, options).ok, false);
  ixs.pop();
  ixs.push(ixs[0]);
  assert.equal(verifyPredictSwapTx(transaction, options).ok, false);
});

test('registry scores a swap only at finality, persists it, and rejects attestation replay or false attribution', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fuse-v210-'));
  const storePath = path.join(dir, 'receipts.json');
  try {
    await writeFile(storePath, JSON.stringify([{ ok: true, signature: 'legacy', wallet, spent: 900,
      evidence: 'CONFIRMED_ONCHAIN_SWAP', attribution: 'KULT_FUSE_MEMO' }]));
    let finalized = false;
    const params = {
      storePath, retryDelaysMs: [0], recheckMs: 0, attestation, resolveMarketMints: async () => expectedMints,
      lookup: async sig => finalized ? tx({ txSignature: sig }) : null,
      lookupConfirmed: async () => tx()
    };
    const registry = createPredictRegistry(params);
    const input = { signature, wallet, marketPda };
    assert.equal((await registry.record(input)).state, 'confirmed');
    assert.equal((await registry.stats()).finalizedSwaps, 0);
    finalized = true;
    const records = await Promise.all([registry.record(input), registry.record(input)]);
    assert.equal(records[0].receipt.evidence, 'FINALIZED_ONCHAIN_SWAP');
    assert.equal(records[1].alreadyRecorded, true);
    assert.equal((await registry.record({ ...input, wallet: address() })).state, 'rejected');
    assert.match((await registry.record({ ...input, signature: base58(randomBytes(64)) })).reason, /already registered/);
    const restarted = createPredictRegistry(params);
    const stats = await restarted.stats();
    assert.equal(stats.finalizedSwaps, 1);
    assert.equal(stats.mUsdcVolume, 5);
    assert.equal((await restarted.receipt(signature)).slot, 42);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('Devnet RPC check refuses an endpoint that returns another cluster genesis', async () => {
  await assertDevnet({ getGenesisHash: async () => DEVNET_GENESIS });
  await assert.rejects(assertDevnet({ getGenesisHash: async () => 'other' }), /not Solana Devnet/);
});

// ---- v2.1.1 -------------------------------------------------------------------------------
test('v2.1.1: a swap reported before finality reaches the scoreboard after the tab closes, across a restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fuse-v211-'));
  try {
    let finalized = false;
    const params = { storePath: path.join(dir, 'receipts.json'), retryDelaysMs: [0], attestation, resolveMarketMints: async () => expectedMints,
      lookup: async sig => finalized ? tx({ txSignature: sig }) : null, lookupConfirmed: async () => tx() };
    const browser = createPredictRegistry(params);
    const first = await browser.record({ signature, wallet, marketPda });
    assert.equal(first.state, 'confirmed');
    assert.equal(first.queued, true);
    // The trader closes the tab here. The server restarts before finality.
    finalized = true;
    const server = createPredictRegistry(params);
    assert.equal(await server.pendingCount(), 1, 'the queue is on disk');
    const run = await server.sweep();
    assert.equal(run.finalized, 1);
    assert.equal(await server.pendingCount(), 0);
    assert.equal((await server.stats()).finalizedSwaps, 1);
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test('v2.1.1: browser polls for a queued swap are answered without another RPC lookup', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fuse-v211-'));
  try {
    let lookups = 0, t = 1_000_000;
    const registry = createPredictRegistry({ storePath: path.join(dir, 'r.json'), retryDelaysMs: [0], attestation, resolveMarketMints: async () => expectedMints,
      lookup: async () => { lookups += 1; return null; }, lookupConfirmed: async () => tx(), clock: () => t, recheckMs: 4000 });
    await registry.record({ signature, wallet, marketPda });
    await registry.record({ signature, wallet, marketPda });
    await registry.record({ signature, wallet, marketPda });
    assert.equal(lookups, 1);
    t += 4001;
    await registry.record({ signature, wallet, marketPda });
    assert.equal(lookups, 2);
    // A different wallet claiming the same signature is not served from the cache.
    await registry.record({ signature, wallet: address(), marketPda });
    assert.equal(lookups, 3);
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test('v2.1.1: failed swaps leave the queue and stale entries expire', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fuse-v211-'));
  try {
    let t = 5_000_000, failed = false;
    const registry = createPredictRegistry({ storePath: path.join(dir, 'r.json'), retryDelaysMs: [0], attestation, resolveMarketMints: async () => expectedMints,
      lookup: async () => null, lookupConfirmed: async () => (failed ? { meta: { err: { InstructionError: [0, 'x'] } } } : tx()), clock: () => t, pendingTtlMs: 60_000 });
    const other = base58(randomBytes(64));
    await registry.record({ signature, wallet, marketPda });
    await registry.record({ signature: other, wallet, marketPda });
    assert.equal(await registry.pendingCount(), 2);
    failed = true; t += 5000;
    await registry.sweep();
    assert.equal(await registry.pendingCount(), 0, 'failed on Solana: dequeued');
    failed = false;
    await registry.record({ signature, wallet, marketPda });
    t += 61_000;
    const run = await registry.sweep();
    assert.equal(run.dropped, 1);
    assert.equal(await registry.pendingCount(), 0);
  } finally { await rm(dir, { force: true, recursive: true }); }
});

// ---- v2.1.2 -------------------------------------------------------------------------------
test('v2.1.2: a trade signed in Phantom still counts when Phantom adds Lighthouse guards and a priority fee', () => {
  const lighthouse = { programId: 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', accounts: [wallet], data: '3Bxs4Bc3VYuGVB19' };
  const priority = { programId: 'ComputeBudget111111111111111111111111111111', accounts: [], data: '3DTZbgwsozUF' };
  assert.equal(verifyPredictSwapTx(tx({ extra: [priority, lighthouse] }), options).ok, true);
});

test('v2.1.2: any other extra program still fails attestation', () => {
  const other = { programId: address(), accounts: [wallet], data: '1' };
  assert.equal(verifyPredictSwapTx(tx({ extra: [other] }), options).ok, false);
});

// ---- v2.1.3: sells ----------------------------------------------------------------------------
function sellTx({ dir = 2, amount = 3_000_000, minOut = 1_500_000, sold = 3_000_000, credit = 1_600_000, otherDelta = 0, sellMemo } = {}) {
  const sellIntent = { wallet, marketPda, blockhash, side: dir === 2 ? 'yes' : 'no', amountRaw: amount, minOutRaw: minOut, action: 'sell' };
  const data = Buffer.alloc(25);
  anchorIx('swap').copy(data); data[8] = dir;
  data.writeBigUInt64LE(BigInt(amount), 9); data.writeBigUInt64LE(BigInt(minOut), 17);
  const mintSold = dir === 2 ? expectedMints.yes : expectedMints.no, other = dir === 2 ? expectedMints.no : expectedMints.yes;
  const token = (mint, amt) => ({ owner: wallet, mint, uiTokenAmount: { amount: String(amt) } });
  return {
    slot: 43, blockTime: nowSec,
    transaction: { signatures: [signature], message: { recentBlockhash: blockhash, accountKeys: [{ pubkey: wallet, signer: true }], instructions: [
      { programId: PROGRAM_ID, accounts: [wallet, marketPda, DEVNET_MUSDC, expectedMints.yes, expectedMints.no], data: base58(data) },
      { programId: MEMO_PROGRAM_ID, parsed: sellMemo ?? attestation.issue(sellIntent) }] } },
    meta: { err: null,
      preTokenBalances: [token(DEVNET_MUSDC, 1_000_000), token(mintSold, 10_000_000), token(other, 2_000_000)],
      postTokenBalances: [token(DEVNET_MUSDC, 1_000_000 + credit), token(mintSold, 10_000_000 - sold), token(other, 2_000_000 + otherDelta)] }
  };
}

test('v2.1.3: an attested sell counts, with its mUSDC received as volume', () => {
  const r = verifyPredictSwapTx(sellTx(), options);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.action, 'sell'); assert.equal(r.side, 'yes');
  assert.equal(r.received, 1.6); assert.equal(r.spent, 0);
  assert.equal(r.mUsdcReceivedRaw, "1600000"); assert.equal(r.outcomeAmountRaw, "3000000");
  assert.ok(Math.abs(r.feeEstimate - 1.6 * 200 / 9800) < 1e-6, 'fee is 2% of the gross USDC output');
  assert.equal(verifyPredictSwapTx(sellTx({ dir: 3 }), options).side, 'no');
});

test('v2.1.3: sells must match the attestation to the unit and pay at least the minimum', () => {
  assert.equal(verifyPredictSwapTx(sellTx({ sold: 2_900_000 }), options).ok, false, 'tokens sold differ from attested amount');
  assert.equal(verifyPredictSwapTx(sellTx({ credit: 1_400_000 }), options).ok, false, 'below the signed minimum');
  assert.equal(verifyPredictSwapTx(sellTx({ otherDelta: 5 }), options).ok, false, 'other outcome must not move');
  const buyMemoOnSell = attestation.issue({ wallet, marketPda, blockhash, side: 'yes', amountRaw: 3_000_000, minOutRaw: 1_500_000 });
  assert.equal(verifyPredictSwapTx(sellTx({ sellMemo: buyMemoOnSell }), options).ok, false, 'a buy attestation cannot be replayed on a sell');
});

test('v2.1.3: YES↔NO swaps are not counted', () => {
  assert.equal(verifyPredictSwapTx(sellTx({ dir: 4 }), options).ok, false);
});

test('v2.1.3: stats count buys and sells, and volume includes both legs', async () => {
  const { statsFromReceipts } = await import('../src/predict/proof.mjs');
  const base = { ok: true, evidence: 'FINALIZED_ONCHAIN_SWAP', attribution: 'FUSE_API_ATTESTED', wallet };
  const s = statsFromReceipts([{ ...base, signature: 'a', spent: 5, action: 'buy' }, { ...base, signature: 'b', received: 3.2, action: 'sell' }, { ...base, signature: 'c', spent: 1 }], true);
  assert.equal(s.buys, 2); assert.equal(s.sells, 1); assert.equal(s.mUsdcVolume, 9.2); assert.equal(s.finalizedSwaps, 3);
});

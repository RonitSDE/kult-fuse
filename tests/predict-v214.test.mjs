import assert from 'node:assert/strict';
import test from 'node:test';
import { nextLpExitStep, LP_EXIT_JOURNAL_KIND } from '../src/predict/lp-exit.mjs';
import { recheckBeforeBroadcast, DEVNET_MUSDC } from '../src/predict/policy.mjs';
import { verifySellEvidence } from '../src/predict/evidence.mjs';

// ---- Fix 1: resumable LP exit ----------------------------------------------------------------
const open = { resolved: false, winningSide: 0, commitClaimable: false, hasLp: true, lpShares: 10_000_000n, yes: 0, no: 0 };

test('v2.1.4 LP exit before resolution: withdraw, then redeem matched pairs, then stop', () => {
  assert.deepEqual(nextLpExitStep(open), { step: 'withdrawLiquidity' });
  const afterWithdraw = { ...open, lpShares: 0n, yes: 7_000_000, no: 4_000_000 };
  assert.deepEqual(nextLpExitStep(afterWithdraw, new Set(['withdrawLiquidity'])), { step: 'redeemPair', amountRaw: 4_000_000 });
  assert.equal(nextLpExitStep({ ...afterWithdraw, yes: 3_000_000, no: 0 }, new Set(['withdrawLiquidity', 'redeemPair'])), null);
});

test('v2.1.4 LP exit resumes after redemption failed once withdrawal landed', () => {
  // New click, fresh run: shares are gone but pairs remain, so the next step is the redemption.
  assert.deepEqual(nextLpExitStep({ ...open, lpShares: 0n, yes: 2_000_000, no: 2_000_000 }), { step: 'redeemPair', amountRaw: 2_000_000 });
});

test('v2.1.4 LP exit after resolution: vault allocation, residuals, winnings; never withdraw', () => {
  const resolved = { ...open, resolved: true, winningSide: 2, commitClaimable: true, hasLp: false, lpShares: 0n };
  assert.deepEqual(nextLpExitStep(resolved), { step: 'claimCommitter' });
  const s2 = { ...resolved, commitClaimable: false, hasLp: true, lpShares: 10_000_000n };
  assert.deepEqual(nextLpExitStep(s2, new Set(['claimCommitter'])), { step: 'claimLpResiduals' });
  const s3 = { ...s2, yes: 5_000_000, no: 1_000_000 };
  assert.deepEqual(nextLpExitStep(s3, new Set(['claimCommitter', 'claimLpResiduals'])), { step: 'claimWinnings' });
  assert.equal(nextLpExitStep({ ...s3, no: 0 }, new Set(['claimCommitter', 'claimLpResiduals'])), null, 'only losing tokens: nothing to claim');
  assert.equal(nextLpExitStep({ ...s3, winningSide: 0 }, new Set(['claimLpResiduals'])), null, 'no payable side');
});

test('v2.1.4 every LP exit step has a journal kind', () => {
  for (const step of ['claimCommitter', 'withdrawLiquidity', 'redeemPair', 'claimLpResiduals', 'claimWinnings']) assert.ok(LP_EXIT_JOURNAL_KIND[step]);
});

// ---- Fix 2: recheck after the wallet popup ---------------------------------------------------
const W = 'Wallet1111111111111111111111111111111111111';
const M = 'Market111111111111111111111111111111111111';
const now = 1_800_000_000_000;
const session = { wallet: W, marketPda: M, maxSingle: 10, maxTotal: 25, spent: 5, killed: false, expiresAtMs: now + 60_000 };
const market = { resolved: false, endTs: now / 1000 + 3600 };
const base = { action: 'buy', mandate: session, wallet: W, activeWallet: W, signer: W, marketPda: M, amount: 5, market, nowMs: now };

test('v2.1.4 broadcast recheck passes for an unchanged session', () => {
  assert.deepEqual(recheckBeforeBroadcast(base), { ok: true });
});

test('v2.1.4 broadcast recheck blocks wallet switch, pause, expiry and spent budget', () => {
  assert.match(recheckBeforeBroadcast({ ...base, activeWallet: 'Other' }).reason, /Wallet changed/);
  assert.match(recheckBeforeBroadcast({ ...base, signer: 'Other' }).reason, /different wallet signed/);
  assert.match(recheckBeforeBroadcast({ ...base, mandate: { ...session, killed: true } }).reason, /paused/);
  assert.match(recheckBeforeBroadcast({ ...base, nowMs: now + 61_000, market: { ...market, endTs: now / 1000 + 9999 } }).reason, /expired/);
  assert.match(recheckBeforeBroadcast({ ...base, mandate: { ...session, spent: 22 } }).reason, /budget/);
  assert.match(recheckBeforeBroadcast({ ...base, mandate: null }).reason, /No approved session/);
  assert.match(recheckBeforeBroadcast({ ...base, market: { ...market, endTs: now / 1000 - 1 } }).reason, /Market closed/);
});

test('v2.1.4 sells need no budget but a pause still stops them', () => {
  assert.deepEqual(recheckBeforeBroadcast({ ...base, action: 'sell', mandate: null }), { ok: true });
  assert.deepEqual(recheckBeforeBroadcast({ ...base, action: 'sell', mandate: { ...session, spent: 25 } }), { ok: true });
  assert.match(recheckBeforeBroadcast({ ...base, action: 'sell', mandate: { ...session, killed: true } }).reason, /paused/);
  assert.match(recheckBeforeBroadcast({ ...base, action: 'sell', activeWallet: 'Other' }).reason, /Wallet changed/);
});

// ---- Fix 3: sell evidence for the submission checker -----------------------------------------
const YES = 'YesMint111111111111111111111111111111111111', NO = 'NoMint1111111111111111111111111111111111111';
const SIG = 'S'.repeat(88);
const featured = { marketPda: M, yesMint: YES, noMint: NO, endTs: 1_800_000_000 };
const bal = (mint, amount) => ({ owner: W, mint, uiTokenAmount: { amount: String(amount) } });
function sellFixture({ dir = 2, amount = 3_000_000, minOut = 1_500_000, sold = 3_000_000, credit = 1_600_000, other = 0, blockTime = 1_799_999_000 } = {}) {
  const data = Buffer.alloc(25); data[8] = dir; data.writeBigUInt64LE(BigInt(amount), 9); data.writeBigUInt64LE(BigInt(minOut), 17);
  const outcome = dir === 2 ? YES : NO, otherMint = dir === 2 ? NO : YES;
  const tx = { slot: 500, blockTime, transaction: { signatures: [SIG] }, meta: {
    preTokenBalances: [bal(outcome, 10_000_000), bal(otherMint, 1_000_000), bal(DEVNET_MUSDC, 50_000_000)],
    postTokenBalances: [bal(outcome, 10_000_000 - sold), bal(otherMint, 1_000_000 + other), bal(DEVNET_MUSDC, 50_000_000 + credit)] } };
  const receipt = { signature: SIG, marketPda: M, action: 'sell', side: dir === 2 ? 'yes' : 'no', wallet: W, outcomeMint: outcome,
    mUsdcReceivedRaw: String(credit), slot: 500, evidence: 'FINALIZED_ONCHAIN_SWAP', attribution: 'FUSE_API_ATTESTED' };
  return { tx, data, wallet: W, market: featured, launchSlot: 100, receipt };
}

test('v2.1.4 a finalized attested sell passes the evidence check', () => {
  const r = verifySellEvidence(sellFixture());
  assert.equal(r.side, 'yes'); assert.equal(r.receivedRaw, 1_600_000n); assert.equal(r.amountRaw, 3_000_000n);
  assert.equal(verifySellEvidence(sellFixture({ dir: 3 })).side, 'no');
});

test('v2.1.4 sell evidence rejects buys, mismatched movements, late sells and bad receipts', () => {
  assert.throws(() => verifySellEvidence(sellFixture({ dir: 0 })), /YES→mUSDC/);
  assert.throws(() => verifySellEvidence(sellFixture({ dir: 4 })), /YES→mUSDC/);
  assert.throws(() => verifySellEvidence(sellFixture({ sold: 2_000_000 })), /token movements/);
  assert.throws(() => verifySellEvidence(sellFixture({ credit: 1_000_000 })), /token movements/);
  assert.throws(() => verifySellEvidence(sellFixture({ other: 1 })), /token movements/);
  assert.throws(() => verifySellEvidence(sellFixture({ blockTime: 1_800_000_000 })), /before the market closes/);
  assert.throws(() => verifySellEvidence({ ...sellFixture(), launchSlot: 600 }), /launch/);
  const f = sellFixture();
  assert.throws(() => verifySellEvidence({ ...f, receipt: { ...f.receipt, action: 'buy' } }), /receipt/);
  assert.throws(() => verifySellEvidence({ ...f, receipt: { ...f.receipt, mUsdcReceivedRaw: '1' } }), /receipt/);
  assert.throws(() => verifySellEvidence({ ...f, receipt: { ...f.receipt, attribution: 'NONE' } }), /receipt/);
});

test('v2.1.4 v2.1.3 sell receipts without the raw field still match via received', () => {
  const f = sellFixture();
  const { mUsdcReceivedRaw, ...legacy } = f.receipt;
  assert.equal(verifySellEvidence({ ...f, receipt: { ...legacy, received: 1.6 } }).receivedRaw, 1_600_000n);
});

// ---- LP exit stays on one wallet ----------------------------------------------------------------
import { pinWallet, assertActiveWallet, WalletChangedError } from '../src/predict/pinned-wallet.mjs';

test('v2.1.4 pinned wallet signs only while the same account is active', async () => {
  const A = { toBase58: () => 'A' }, B = { toBase58: () => 'B' };
  let active = { publicKey: A };
  const signed = [];
  const pinned = pinWallet({ publicKey: A, async signTransaction(tx) { signed.push(tx); return tx; },
    async signAllTransactions(txs) { return txs; } }, () => active);
  assert.equal(await pinned.signTransaction('tx1'), 'tx1');
  active = { publicKey: B };
  await assert.rejects(pinned.signTransaction('tx2'), WalletChangedError);
  assert.deepEqual(signed, ['tx1'], 'no popup opens once the account changed');
  assert.equal(pinned.publicKey, A, 'address stays frozen for reads and building');
  assert.throws(() => pinned.assertActive(), WalletChangedError);
  active = null;
  assert.throws(() => assertActiveWallet(A, () => active), WalletChangedError, 'disconnect also stops the flow');
});

test('v2.1.4 an account switch during the signing popup is caught before the result is used', async () => {
  const A = { toBase58: () => 'A' }, B = { toBase58: () => 'B' };
  let active = { publicKey: A };
  const pinned = pinWallet({ publicKey: A, async signTransaction(tx) { active = { publicKey: B }; return tx; },
    async signAllTransactions(txs) { return txs; } }, () => active);
  await assert.rejects(pinned.signTransaction('tx'), WalletChangedError);
});

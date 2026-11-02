/**
 * One Flash devnet open → resize → close, with the Fuse program authorizing each target.
 * Refuses mainnet. Requires CONFIRM_DEVNET_PROOF=YES.
 * Writes docs/devnet-proof.json. Does not print private keys.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { FlashPerpAdapter } from '../src/adapters/perp/flash-perp.mjs';
import { AnchorFuseClient } from '../src/adapters/store/anchor-fuse-client.mjs';
import { policyHash } from '../src/core/policy.mjs';
import { createReceipt } from '../src/core/receipt.mjs';

const cluster = process.env.SOLANA_CLUSTER || 'devnet';
if (cluster !== 'devnet') throw new Error('Refusing non-devnet proof run');
if (process.env.CONFIRM_DEVNET_PROOF !== 'YES') throw new Error('Set CONFIRM_DEVNET_PROOF=YES to submit the devnet proof run');

const OPEN_USD = 15;
const RESIZE_USD = 25;
const FAUCET = new (await import('@solana/web3.js')).PublicKey('4sN8PnN2ki2W4TFXAfzR645FWs8nimmsYeNtxM8RBK6A');
const USDC = new (await import('@solana/web3.js')).PublicKey('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr');
const TOKEN_PROGRAM = new (await import('@solana/web3.js')).PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED = new (await import('@solana/web3.js')).PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function client(keyEnv) {
  return new AnchorFuseClient({ ...process.env, FUSE_AUTHORITY_PRIVATE_KEY_JSON: process.env[keyEnv] });
}

async function usdcBalance(connection, owner, web3) {
  const ata = web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC.toBuffer()],
    ASSOCIATED
  )[0];
  const info = await connection.getAccountInfo(ata);
  if (!info) return { ata, amount: 0 };
  const bal = await connection.getTokenAccountBalance(ata);
  return { ata, amount: Number(bal.value.amount) };
}

async function ensureUsdc(connection, payer, web3) {
  const { ata, amount } = await usdcBalance(connection, payer.publicKey, web3);
  if (amount >= 40_000_000) return;
  const [mint, bump] = web3.PublicKey.findProgramAddressSync([Buffer.from('faucet-mint')], FAUCET);
  if (!mint.equals(USDC)) throw new Error('devnet USDC faucet mint does not match Flash collateral');
  const disc = crypto.createHash('sha256').update('global:airdrop').digest().subarray(0, 8);
  const data = Buffer.alloc(8 + 1 + 8);
  disc.copy(data, 0);
  data.writeUInt8(bump, 8);
  data.writeBigUInt64LE(100_000_000n, 9);
  const ix = new web3.TransactionInstruction({
    programId: FAUCET,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED, isSigner: false, isWritable: false },
      { pubkey: web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ],
    data
  });
  const tx = new web3.Transaction().add(ix);
  const sig = await web3.sendAndConfirmTransaction(connection, tx, [payer]);
  console.log('USDC faucet', sig);
}

const owner = client('FUSE_OWNER_PRIVATE_KEY_JSON');
const oracle = client('FUSE_ORACLE_PRIVATE_KEY_JSON');
const exec = client('FUSE_EXECUTION_PRIVATE_KEY_JSON');
await owner.init();
await oracle.init();
await exec.init();

const flash = new FlashPerpAdapter({
  rpcUrl: process.env.SOLANA_RPC_URL,
  commitment: process.env.SOLANA_COMMITMENT || 'confirmed',
  privateKeyJson: process.env.FLASH_PRIVATE_KEY_JSON,
  cluster: 'devnet',
  poolName: process.env.FLASH_POOL || 'devnet.1',
  targetSymbol: 'SOL',
  collateralSymbol: 'USDC',
  leverageX: 1,
  maxSlippageBps: 800,
  minOrderUsd: 5
});
await flash.init();
await ensureUsdc(flash.connection, flash.wallet.payer, flash.sdk.web3);

const before = await flash.getPosition();
if (Number(before.exposureUsd || 0) > 1) throw new Error(`Flash position already open at $${before.exposureUsd}; close it before a proof run`);

const policy = {
  version: 1,
  type: 'STEP',
  eventMarket: 'devnet-proof-run',
  outcomeId: 'YES',
  consequence: 'SOL-PERP-LONG',
  steps: [{ pBps: 5000, exposureUsd: OPEN_USD }, { pBps: 6000, exposureUsd: RESIZE_USD }],
  killBelowBps: 3500,
  riskCapUsd: RESIZE_USD,
  maxLeverageBps: 10000,
  lossStopUsd: 50,
  hysteresisBps: 100,
  confirmationCount: 1,
  minRebalanceUsd: 5,
  maxOracleAgeSec: 120,
  maxSpreadBps: 1200,
  expiryTs: Math.floor(Date.now() / 1000) + 86400,
  venue: 'FLASH',
  marketId: 'SOL-PERP'
};
const hash = policyHash(policy);
const fuseId = BigInt(Date.now());
const created = await owner.initFuse({
  fuseId,
  policy,
  agent: owner.wallet.publicKey.toBase58(),
  executionAuthority: exec.wallet.publicKey.toBase58(),
  oracleAuthority: oracle.wallet.publicKey.toBase58()
});
for (const c of [owner, oracle, exec]) c.fusePda = new owner.web3.PublicKey(created.fuse);
const arm = await owner.arm();

const now = () => Math.floor(Date.now() / 1000);
let sequence = 1;
let nonce = 1;
let prev = ''.padStart(64, '0');
const receipts = [];

async function observe(pBps) {
  const sig = await oracle.acceptObservation({ pBps, markPrice: 0, sequence, observedTs: now() });
  sequence += 1;
  return sig;
}
async function authorize(targetUsd, reason) {
  const sig = await exec.setTarget({ targetUsd, nonce, reason });
  const used = nonce;
  nonce += 1;
  return { sig, nonce: used };
}
function receipt({ pBps, beforeUsd, afterUsd, filled, reason, txSignature, venueRef }) {
  const row = createReceipt({
    fuseId: created.fuse,
    sequence: receipts.length + 1,
    prevReceiptHash: prev,
    observedProbabilityBps: pBps,
    desiredExposureBeforeUsd: beforeUsd,
    desiredExposureAfterUsd: afterUsd,
    actualExposureBeforeUsd: beforeUsd,
    filledExposureAfterUsd: filled,
    markPrice: 0,
    reason,
    venue: 'FLASH',
    venueRef,
    txSignature,
    policyHash: hash
  });
  prev = row.hash;
  receipts.push(row);
  return row;
}

try {
await observe(5200);
const openTarget = await authorize(OPEN_USD, 'INITIAL_OPEN');
const opened = await flash.executeTarget(OPEN_USD, { clientOrderId: `proof-open-${fuseId}` });
const openPos = await flash.getPosition();
const openReceipt = receipt({
  pBps: 5200, beforeUsd: 0, afterUsd: OPEN_USD, filled: Number(openPos.exposureUsd || 0),
  reason: 'INITIAL_OPEN', txSignature: opened.txSignature, venueRef: opened.venueRef
});
await exec.recordFill({ filledExposureUsd: Math.round(Number(openPos.exposureUsd || 0)), venueRef: opened.venueRef, receiptHash: openReceipt.hash, nonce: openTarget.nonce, reason: 'INITIAL_OPEN' });

await observe(6400);
const resizeTarget = await authorize(RESIZE_USD, 'PROBABILITY_STEP_UP');
const resized = await flash.executeTarget(RESIZE_USD, { clientOrderId: `proof-resize-${fuseId}` });
const resizePos = await flash.getPosition();
const resizeReceipt = receipt({
  pBps: 6400, beforeUsd: OPEN_USD, afterUsd: RESIZE_USD, filled: Number(resizePos.exposureUsd || 0),
  reason: 'PROBABILITY_STEP_UP', txSignature: resized.txSignature, venueRef: resized.venueRef
});
await exec.recordFill({ filledExposureUsd: Math.round(Number(resizePos.exposureUsd || 0)), venueRef: resized.venueRef, receiptHash: resizeReceipt.hash, nonce: resizeTarget.nonce, reason: 'PROBABILITY_STEP_UP' });

await observe(2900);
const kill = await exec.killProbability();
const closeTarget = await authorize(0, 'KILL_PROBABILITY');
const closed = await flash.executeTarget(0, { clientOrderId: `proof-close-${fuseId}`, reduceOnly: true });
const finalPos = await flash.getPosition();
const residual = Number(finalPos.exposureUsd || 0);
const closeReceipt = receipt({
  pBps: 2900, beforeUsd: RESIZE_USD, afterUsd: 0, filled: residual,
  reason: 'KILL_PROBABILITY', txSignature: closed.txSignature, venueRef: closed.venueRef
});
await exec.recordFill({ filledExposureUsd: Math.round(residual), venueRef: closed.venueRef, receiptHash: closeReceipt.hash, nonce: closeTarget.nonce, reason: 'KILL_PROBABILITY' });

if (!opened.txSignature || !resized.txSignature || !closed.txSignature) throw new Error('Flash open, resize, and close each need a signature');
for (const [name, sig] of [['flashOpen', opened.txSignature], ['flashResize', resized.txSignature], ['flashClose', closed.txSignature]]) {
  const tx = await flash.connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (!tx || tx.meta?.err) throw new Error(`${name} ${sig} did not confirm: ${JSON.stringify(tx?.meta?.err || 'missing')}`);
}
if (Math.abs(residual) > 1) throw new Error(`residual exposure $${residual} is above $1`);

const proof = {
  label: `Flash devnet SOL/USDC ${flash.sideName} open → resize → close`,
  network: 'devnet',
  side: flash.sideName,
  fuse: created.fuse,
  policyHash: hash,
  openUsd: OPEN_USD,
  resizeUsd: RESIZE_USD,
  residualUsd: residual,
  recordedAt: new Date().toISOString(),
  transactions: {
    create: created.signature,
    arm,
    target: resizeTarget.sig,
    kill,
    flashOpen: opened.txSignature,
    flashResize: resized.txSignature,
    flashClose: closed.txSignature
  },
  receipts: receipts.map((r) => ({
    sequence: r.sequence,
    observedProbabilityBps: r.observedProbabilityBps,
    desiredExposureAfterUsd: r.desiredExposureAfterUsd,
    filledExposureAfterUsd: r.filledExposureAfterUsd,
    reason: r.reason,
    hash: r.hash,
    txSignature: r.txSignature,
    prevReceiptHash: r.prevReceiptHash,
    policyHash: r.policyHash
  }))
};
await fs.writeFile(new URL('../docs/devnet-proof.json', import.meta.url), `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify({ fuse: proof.fuse, residualUsd: residual, transactions: proof.transactions }, null, 2));
} catch (error) {
  try {
    const stuck = await flash.getPosition();
    if (Number(stuck.exposureUsd || 0) > 1) {
      console.error(`closing residual $${stuck.exposureUsd} after failure`);
      await flash.executeTarget(0, { clientOrderId: `proof-abort-${fuseId}`, reduceOnly: true });
    }
  } catch (closeError) {
    console.error('residual close failed:', closeError.message);
  }
  throw error;
}

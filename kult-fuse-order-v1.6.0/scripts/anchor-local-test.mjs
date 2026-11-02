import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const idlPath = process.env.FUSE_IDL_PATH || path.join(repoRoot, 'contracts/fuse-anchor/target/idl/kult_fuse.json');

const anchor = await import('@coral-xyz/anchor');
const web3 = await import('@solana/web3.js');

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const idl = JSON.parse(await fs.readFile(idlPath, 'utf8'));
const program = new anchor.Program(idl, provider);
const owner = provider.wallet.publicKey;
const fuseId = new anchor.BN(Date.now());
const idBuf = Buffer.alloc(8);
idBuf.writeBigUInt64LE(BigInt(fuseId.toString()));
const [fuse] = web3.PublicKey.findProgramAddressSync(
  [Buffer.from('fuse'), owner.toBuffer(), idBuf],
  program.programId
);
const bn = (v) => new anchor.BN(String(v));
const now = Math.floor(Date.now() / 1000);
const zeros32 = Array(32).fill(0);
const zeros16 = Array(16).fill(0);

const params = {
  agent: owner,
  executionAuthority: owner,
  oracleAuthority: owner,
  eventMarket: zeros32,
  outcomeId: zeros16,
  oracleKind: 1,
  curveHash: Array(32).fill(7),
  curveVersion: 1,
  stepCount: 5,
  stepThresholdsBps: [3500, 5000, 6000, 7000, 8000],
  stepExposuresUsd: [bn(100), bn(200), bn(300), bn(420), bn(500)],
  riskCapUsd: bn(500),
  maxLeverageBps: 10_000,
  killProbabilityBps: 3500,
  hysteresisBps: 100,
  maxOracleAgeSec: 60,
  lossStopUsd: bn(50),
  expiryTs: bn(now + 3600),
  venue: 1,
  marketId: zeros32,
};

console.log(`Anchor smoke program=${program.programId.toBase58()} fuse=${fuse.toBase58()}`);

await program.methods
  .initFuse(fuseId, params)
  .accounts({ owner, fuse, systemProgram: web3.SystemProgram.programId })
  .rpc();
await program.methods.armFuse().accounts({ owner, fuse }).rpc();

await program.methods
  .acceptObservation(6100, bn(150_000_000), bn(1), bn(now))
  .accounts({ oracleAuthority: owner, fuse })
  .rpc();
await program.methods
  .setTarget(bn(300), bn(1), 1)
  .accounts({ executionAuthority: owner, fuse })
  .rpc();
await program.methods
  .recordFill(bn(300), zeros32, Array(32).fill(1), bn(1), 1)
  .accounts({ executionAuthority: owner, fuse })
  .rpc();

let state = await program.account.fuseAccount.fetch(fuse);
if (Number(state.desiredExposureUsd.toString()) !== 300 || Number(state.filledExposureUsd.toString()) !== 300) {
  throw new Error('Anchor smoke: 61% should authorize/fill $300');
}

await program.methods
  .acceptObservation(2800, bn(145_000_000), bn(2), bn(now + 1))
  .accounts({ oracleAuthority: owner, fuse })
  .rpc();
await program.methods
  .setTarget(bn(0), bn(2), 5)
  .accounts({ executionAuthority: owner, fuse })
  .rpc();
await program.methods
  .recordFill(bn(0), zeros32, Array(32).fill(2), bn(2), 5)
  .accounts({ executionAuthority: owner, fuse })
  .rpc();

state = await program.account.fuseAccount.fetch(fuse);
const killed = state.status && Object.prototype.hasOwnProperty.call(state.status, 'killed');
if (!killed || Number(state.desiredExposureUsd.toString()) !== 0 || Number(state.filledExposureUsd.toString()) !== 0) {
  throw new Error('Anchor smoke: 28% should produce absorbing KILLED / $0');
}

// Negative test: an absorbing kill may never reopen.
let rejected = false;
try {
  await program.methods
    .setTarget(bn(420), bn(3), 2)
    .accounts({ executionAuthority: owner, fuse })
    .rpc();
} catch {
  rejected = true;
}
if (!rejected) throw new Error('Anchor smoke: killed Fuse reopened unexpectedly');

console.log('ANCHOR LOCAL INTEGRATION PASS: init → arm → 61%/$300 → 28%/KILLED → $0; reopen rejected');

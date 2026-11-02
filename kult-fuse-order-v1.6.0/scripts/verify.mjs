// Independent verifier. Fetches the Fuse and its receipts (from a deployed app with --url, or local DATA_DIR)
// and checks every fill against Solana itself through a public RPC. It needs no keys from the server.
import fs from 'node:fs/promises';
import { FileStore } from '../src/adapters/store/file-store.mjs';
import { verifyExecution } from '../src/core/verifier.mjs';
import { driftVenueEvidence } from '../src/adapters/perp/drift-evidence.mjs';
import { fuseFillEvidence } from '../src/adapters/store/fuse-evidence.mjs';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const appUrl = arg('--url')?.replace(/\/$/, '') || null;
const proofFile = arg('--file');

let fuse, receipts, fusePda, expectedVenueUser;
if (proofFile) {
  // A proof-run file: { fuse, receipts } as written by scripts/venue-proof-run.mjs.
  const proof = JSON.parse(await fs.readFile(proofFile, 'utf8'));
  const runs = proof.mandates || [];
  const i = Number(arg('--mandate') || 0);
  ({ fuse, receipts = [] } = runs[i] || {});
  fusePda = fuse?.chainFuse;
  expectedVenueUser = proof.venueUser;
} else if (appUrl) {
  const res = await fetch(`${appUrl}/api/state`);
  if (!res.ok) { console.error(`GET ${appUrl}/api/state -> ${res.status}`); process.exit(2); }
  const state = await res.json();
  ({ fuse, receipts = [] } = state);
  fusePda = state.integrity?.fusePda || fuse?.chainFuse;
  expectedVenueUser = state.position?.positionRef;
} else {
  const store = new FileStore(process.env.DATA_DIR || './.data');
  fuse = await store.read('fuse'); receipts = await store.read('receipts', []);
  fusePda = fuse?.chainFuse;
}
expectedVenueUser = arg('--venue-user') || expectedVenueUser || process.env.VERIFY_VENUE_USER;
if (!fuse) { console.error('No Fuse state found. Pass --url <app> or start the server so it creates a Fuse.'); process.exit(2); }

const [web3, anchor] = await Promise.all([import('@solana/web3.js'), import('@coral-xyz/anchor')]);
const rpc = process.env.VERIFY_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const connection = new web3.Connection(rpc, 'confirmed');
const idl = JSON.parse(await fs.readFile(process.env.FUSE_IDL_PATH || './deploy/idl/kult_fuse.json', 'utf8'));
const coder = new anchor.BorshAccountsCoder(idl);
const fuseProgram = { programId: new web3.PublicKey(idl.address), coder: new anchor.BorshCoder(idl) };
async function onchainFuse() {
  if (!fusePda) return null;
  const info = await connection.getAccountInfo(new web3.PublicKey(fusePda));
  if (!info || !info.owner.equals(fuseProgram.programId)) return null;
  return coder.decode('FuseAccount', info.data);
}

// Venue fills may live on another cluster than the Fuse program (e.g. Drift mainnet, Fuse devnet).
const PUBLIC_RPC = { 'mainnet-beta': 'https://api.mainnet-beta.solana.com', devnet: 'https://api.devnet.solana.com' };
const venueConnections = {};
const connFor = (cluster) => {
  if (!cluster || cluster === (process.env.SOLANA_CLUSTER || 'devnet')) return connection;
  return (venueConnections[cluster] ||= new web3.Connection(process.env.VENUE_RPC_URL || PUBLIC_RPC[cluster], 'confirmed'));
};

let driftProgram;
async function programForDrift(cluster) {
  if (driftProgram) return driftProgram;
  const imported = await import('@drift-labs/sdk');
  const sdk = imported.default?.DriftClient ? imported.default : imported;
  const venueEnv = cluster || process.env.DRIFT_ENV || 'devnet';
  const venueConn = connFor(venueEnv);
  sdk.initialize({ env: venueEnv });
  const client = new sdk.DriftClient({
    connection: venueConn, wallet: new sdk.Wallet(web3.Keypair.generate()), env: venueEnv,
    perpMarketIndexes: [0], spotMarketIndexes: [0],
    accountSubscription: { type: 'polling', accountLoader: new sdk.BulkAccountLoader(venueConn, 'confirmed', 1000) }
  });
  driftProgram = client.program;
  return driftProgram;
}

const chain = {
  fuseState: async () => {
    const acct = await onchainFuse();
    return acct ? { policyHash: Buffer.from(acct.curveHash).toString('hex') } : null;
  },
  fillEvidence: (sig, receipt) => fuseFillEvidence({ connection, program: fuseProgram, fusePda, signature: sig, receipt }),
  txStatus: async (sig, cluster) => {
    const { value } = await connFor(cluster).getSignatureStatuses([sig], { searchTransactionHistory: true });
    const st = value?.[0];
    return { confirmed: Boolean(st && ['confirmed', 'finalized'].includes(st.confirmationStatus)), err: st?.err ?? null };
  },
  venueEvidence: async (sig, receipt) => {
    if (receipt.venue !== 'DRIFT') return { ok: false, why: 'no fill decoder for this venue' };
    if (!expectedVenueUser || receipt.venueRef !== expectedVenueUser) return { ok: false, why: 'expected venue account is missing or mismatched' };
    if (receipt.marketId !== fuse.policy.marketId || receipt.marketId !== 'SOL-PERP') return { ok: false, why: 'perp market mismatch' };
    return driftVenueEvidence({
      connection: connFor(receipt.venueCluster), program: await programForDrift(receipt.venueCluster),
      user: expectedVenueUser, marketIndex: 0, signature: sig, receipt,
      toleranceBase: 1e-8
    });
  },
  receiptHead: async () => {
    const acct = await onchainFuse();
    if (!acct) return null;
    return Buffer.from(acct.lastReceiptHash || acct.last_receipt_hash).toString('hex');
  }
};

const result = await verifyExecution({ fuse, receipts, chain });
console.log(`\nKULT FUSE VERIFIER  (${proofFile || appUrl || 'local'} · rpc ${rpc})\n==================`);
for (const c of result.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(34)} ${String(c.actual)}`);
for (const f of result.fills) {
  console.log(`\n${f.status.padEnd(10)} ${f.reason}  position $${f.positionUsd}  residual $${f.residualUsd}  status ${f.fuseStatus}  ${new Date(f.timestampMs).toISOString()}`);
  console.log(`           venue  ${f.txSignature}${f.venueCluster ? ` (${f.venueCluster})` : ''}\n           anchor ${f.anchorSignature || '—'}`);
  for (const p of f.problems) console.log(`           ✕ ${p}`);
}
console.log(`\n${result.summary}`);
process.exit(result.ok ? 0 : 1);

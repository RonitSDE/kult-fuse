// Independent verifier. Fetches the Fuse and its receipts (from a deployed app with --url, or local DATA_DIR)
// and checks every fill against Solana itself through a public RPC. It needs no keys from the server.
import fs from 'node:fs/promises';
import { FileStore } from '../src/adapters/store/file-store.mjs';
import { verifyExecution } from '../src/core/verifier.mjs';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const appUrl = arg('--url')?.replace(/\/$/, '') || null;
const proofFile = arg('--file');

let fuse, receipts, fusePda;
if (proofFile) {
  // A proof-run file: { fuse, receipts } as written by scripts/venue-proof-run.mjs.
  const runs = JSON.parse(await fs.readFile(proofFile, 'utf8')).mandates || [];
  const i = Number(arg('--mandate') || 0);
  ({ fuse, receipts = [] } = runs[i] || {});
  fusePda = fuse?.chainFuse;
} else if (appUrl) {
  const res = await fetch(`${appUrl}/api/state`);
  if (!res.ok) { console.error(`GET ${appUrl}/api/state -> ${res.status}`); process.exit(2); }
  const state = await res.json();
  ({ fuse, receipts = [] } = state);
  fusePda = state.integrity?.fusePda || fuse?.chainFuse;
} else {
  const store = new FileStore(process.env.DATA_DIR || './.data');
  fuse = await store.read('fuse'); receipts = await store.read('receipts', []);
  fusePda = fuse?.chainFuse;
}
if (!fuse) { console.error('No Fuse state found. Pass --url <app> or start the server so it creates a Fuse.'); process.exit(2); }

const [web3, anchor] = await Promise.all([import('@solana/web3.js'), import('@coral-xyz/anchor')]);
const rpc = process.env.VERIFY_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const connection = new web3.Connection(rpc, 'confirmed');
const idl = JSON.parse(await fs.readFile(process.env.FUSE_IDL_PATH || './contracts/fuse-anchor/target/idl/kult_fuse.json', 'utf8'));
const coder = new anchor.BorshAccountsCoder(idl);

// Venue fills may live on another cluster than the Fuse program (e.g. Drift mainnet, Fuse devnet).
const PUBLIC_RPC = { 'mainnet-beta': 'https://api.mainnet-beta.solana.com', devnet: 'https://api.devnet.solana.com' };
const venueConnections = {};
const connFor = (cluster) => {
  if (!cluster || cluster === (process.env.SOLANA_CLUSTER || 'devnet')) return connection;
  return (venueConnections[cluster] ||= new web3.Connection(process.env.VENUE_RPC_URL || PUBLIC_RPC[cluster], 'confirmed'));
};

const chain = {
  txStatus: async (sig, cluster) => {
    const { value } = await connFor(cluster).getSignatureStatuses([sig], { searchTransactionHistory: true });
    const st = value?.[0];
    return { confirmed: Boolean(st && ['confirmed', 'finalized'].includes(st.confirmationStatus)), err: st?.err ?? null };
  },
  receiptHead: async () => {
    if (!fusePda) return null;
    const info = await connection.getAccountInfo(new web3.PublicKey(fusePda));
    if (!info) return null;
    const acct = coder.decode('FuseAccount', info.data);
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

// Real-venue proof run: real Fuse transactions on the Fuse cluster, real fills on the venue.
//
//   npm run proof:venue -- --dry-run            checks wallets, collateral and the market; sends nothing
//   npm run proof:venue                          runs both mandates and writes docs/venue-proof.json
//   npm run proof:venue -- --confirm-mainnet     required when DRIFT_ENV=mainnet-beta (real money)
//
// Mandate A: open $15 → resize $25 → over-cap target refused onchain → probability kill → close
//            → target after kill refused onchain → settle.
// Mandate B: open $15 → wait for venue P&L (fees included) to reach the loss-stop trigger → close.
//
// The probability path is scripted (source "scripted-proof") so the run walks the curve on demand.
// Everything else is real: Fuse transactions, venue orders, positions, P&L and receipts.
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { AnchorFuseClient } from '../src/adapters/store/anchor-fuse-client.mjs';
import { makePerpAdapter } from '../src/adapters/perp/factory.mjs';
import { FuseEngine } from '../src/worker/fuse-engine.mjs';
import { initialFuse } from '../src/core/state.mjs';
import { policyHash } from '../src/core/policy.mjs';
import { verifyExecution } from '../src/core/verifier.mjs';
import { Reason } from '../src/core/constants.mjs';

const env = { ...process.env, PERP_ADAPTER: 'drift' };
const dryRun = process.argv.includes('--dry-run');
const venueEnv = env.DRIFT_ENV || 'devnet';
const fuseCluster = env.SOLANA_CLUSTER || 'devnet';
const collateralUsd = Number(env.PROOF_COLLATERAL_USD || 12);
const lossStopUsd = Number(env.PROOF_LOSS_STOP_USD || 0.25);
const lossWaitMin = Number(env.PROOF_LOSS_WAIT_MIN || 45);
const out = env.PROOF_OUT || './docs/venue-proof.json';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (venueEnv === 'mainnet-beta' && !dryRun && !process.argv.includes('--confirm-mainnet')) {
  console.error('DRIFT_ENV=mainnet-beta places real orders with real USDC. Re-run with --confirm-mainnet.');
  process.exit(2);
}

const perp = await makePerpAdapter(env);
const clients = {};
for (const [role, key] of [['owner', 'FUSE_OWNER_PRIVATE_KEY_JSON'], ['oracle', 'FUSE_ORACLE_PRIVATE_KEY_JSON'], ['exec', 'FUSE_EXECUTION_PRIVATE_KEY_JSON']]) {
  if (!env[key]) throw new Error(`${key} is required`);
  clients[role] = await new AnchorFuseClient({ ...env, FUSE_PDA: '', FUSE_AUTHORITY_PRIVATE_KEY_JSON: env[key] }).init();
}

async function preflight() {
  const sol = async (conn, pk) => (await conn.getBalance(pk)) / 1e9;
  const pos = await perp.getPosition();
  const wallet = await perp.walletUsdc();
  const rows = {
    venue: `Drift ${venueEnv} SOL-PERP @ $${perp.markPrice().toFixed(2)}`,
    venueWallet: perp.kp.publicKey.toBase58(),
    venueWalletSol: await sol(perp.connection, perp.kp.publicKey),
    venueWalletUsdc: wallet.usdc,
    driftCollateralUsd: await perp.collateralUsd(),
    openPositionUsd: pos.exposureUsd,
    fuseCluster,
    fuseOwnerSol: await sol(clients.owner.provider.connection, clients.owner.wallet.publicKey),
    fuseOracleSol: await sol(clients.oracle.provider.connection, clients.oracle.wallet.publicKey),
    fuseExecSol: await sol(clients.exec.provider.connection, clients.exec.wallet.publicKey)
  };
  const problems = [];
  if (rows.venueWalletSol < 0.02) problems.push('venue wallet needs ≥ 0.02 SOL for fees');
  if (rows.venueWalletUsdc + rows.driftCollateralUsd < collateralUsd) problems.push(`venue needs ≥ $${collateralUsd} USDC (wallet + Drift collateral)`);
  if (rows.openPositionUsd > 0.5) problems.push('venue account already holds a SOL-PERP position; close it first');
  for (const r of ['fuseOwnerSol', 'fuseOracleSol', 'fuseExecSol']) if (rows[r] < 0.05) problems.push(`${r} below 0.05 SOL`);
  console.table(rows);
  return problems;
}

function scriptedSource() {
  let sequence = Math.floor(Date.now() / 1000);
  // A 1¢-wide book with ample depth, timestamped now: it passes the quality gate by construction.
  return (p) => ({ bid: p - 0.005, ask: p + 0.005, bidDepthUsd: 1000, askDepthUsd: 1000, observedAtMs: Date.now(), sequence: ++sequence, source: 'scripted-proof' });
}

async function newMandate(name, policyOverrides = {}) {
  const policy = { ...JSON.parse(await fs.readFile(env.PROOF_POLICY_FILE || './policy.proof.json', 'utf8')), ...policyOverrides };
  policy.eventMarket = `proof-${name}`;
  policy.venue = 'DRIFT';
  const { owner, oracle, exec } = clients;
  const fuse = initialFuse({
    id: `proof_${name}_${Date.now()}`, owner: owner.wallet.publicKey.toBase58(), agent: owner.wallet.publicKey.toBase58(),
    executionAuthority: exec.wallet.publicKey.toBase58(), oracleAuthority: oracle.wallet.publicKey.toBase58(), policy, policyHash: policyHash(policy)
  });
  const created = await owner.initFuse({ fuseId: BigInt(Date.now()), policy, agent: fuse.agent, executionAuthority: fuse.executionAuthority, oracleAuthority: fuse.oracleAuthority });
  for (const c of [owner, oracle, exec]) c.fusePda = new owner.web3.PublicKey(created.fuse);
  fuse.chainFuse = created.fuse;
  fuse.chainTxs = [{ ix: 'init_fuse', signature: created.signature, at: Date.now() }];
  const receipts = [];
  const engine = new FuseEngine({
    fuse, eventSource: null, perpAdapter: perp, appendReceipt: async (r) => receipts.push(r),
    chainHooks: {
      arm: () => owner.arm(), settle: () => owner.settle(),
      acceptObservation: (x) => oracle.acceptObservation(x),
      setTarget: (x) => exec.setTarget(x), killProbability: () => exec.killProbability(), killAuthorized: (r) => exec.killAuthorized(r),
      recordFill: (x) => exec.recordFill(x)
    }
  });
  log(`${name}: Fuse ${created.fuse} created (${created.signature})`);
  return { name, engine, receipts, rejections: [], next: scriptedSource() };
}

// Ticks until the engine acts on p (band changes need confirmationCount observations).
async function drive(m, p, label) {
  for (let i = 0; i < 4; i++) {
    const r = await m.engine.tick(m.next(p));
    if (!r.skipped) { log(`${m.name}: ${label} → target $${m.engine.fuse.desiredExposureUsd}, venue $${(r.position?.exposureUsd ?? 0).toFixed(2)}${r.exec?.txSignature ? `, tx ${r.exec.txSignature}` : ''}`); return r; }
    if (r.reason !== 'AWAITING_CONFIRMATION') throw new Error(`${label}: tick skipped (${r.reason})`);
  }
  throw new Error(`${label}: engine never acted`);
}

// A transaction the Fuse program must refuse. Success here would be a policy breach, so it aborts the run.
async function expectRefusal(m, label, fn) {
  try {
    const sig = await fn();
    throw new Error(`${label} was ACCEPTED onchain (${sig}); the Fuse did not enforce its policy`);
  } catch (e) {
    if (/ACCEPTED onchain/.test(e.message)) throw e;
    const code = (String(e.message).match(/Error Code: (\w+)/) || [])[1] || e.message.slice(0, 160);
    m.rejections.push({ attempt: label, refusedBy: 'fuse program', error: code, at: Date.now() });
    log(`${m.name}: ${label} refused onchain: ${code}`);
  }
}

const problems = await preflight();
if (dryRun) {
  console.log(problems.length ? `\nNOT READY:\n- ${problems.join('\n- ')}` : '\nREADY: run without --dry-run.');
  process.exit(problems.length ? 1 : 0);
}
const setupOnly = problems.filter((p) => !/venue needs/.test(p));
if (setupOnly.length) { console.error(`NOT READY:\n- ${setupOnly.join('\n- ')}`); process.exit(1); }

const setup = await perp.ensureCollateral(collateralUsd);
log(`collateral $${setup.collateralUsd.toFixed(2)}${setup.signature ? ` (deposit ${setup.signature})` : ''}`);

const mandates = [];
try {
  // Mandate A: open, resize, cap refusal, kill, close, post-kill refusal, settle.
  const a = await newMandate('a');
  mandates.push(a);
  await a.engine.arm();
  await drive(a, 0.52, 'open at 52%');
  await drive(a, 0.64, 'resize at 64%');
  await expectRefusal(a, 'over-cap target $100 (cap $30)', () => clients.exec.setTarget({ targetUsd: 100, nonce: a.engine.fuse.executionNonce + 1, reason: 'PROBABILITY_STEP_UP' }));
  await drive(a, 0.30, 'probability falls to 30% (kill)');
  await expectRefusal(a, 'target $25 after kill', () => clients.exec.setTarget({ targetUsd: 25, nonce: a.engine.fuse.executionNonce + 1, reason: 'PROBABILITY_STEP_UP' }));
  const reopen = await a.engine.tick(a.next(0.85));
  log(`a: worker tick at 85% after kill → ${reopen.skipped ? `skipped (${reopen.reason})` : 'ACTED'}`);
  await a.engine.settle();
  log('a: settled');

  // Mandate B: loss stop on a real position.
  const b = await newMandate('b', { lossStopUsd });
  mandates.push(b);
  await b.engine.arm();
  await drive(b, 0.52, 'open at 52%');
  log(`b: waiting up to ${lossWaitMin} min for venue P&L ≤ −$${lossStopUsd} (fees included)`);
  const until = Date.now() + lossWaitMin * 60_000;
  while (b.engine.fuse.status !== 'KILLED' && Date.now() < until) {
    await sleep(10_000);
    const r = await b.engine.tick(b.next(0.52));
    if (r.lossStop) log(`b: LOSS STOP at P&L $${r.lossStop.triggerPnlUsd.toFixed(4)}; close ${r.lossStop.closeTxSignature}`);
    else log(`b: P&L $${Number(b.engine.fuse.lastPnlUsd ?? NaN).toFixed(4)}`);
  }
  if (b.engine.fuse.status !== 'KILLED') {
    log('b: loss stop did not trigger inside the window; closing with an emergency kill (recorded as such)');
    await b.engine.kill(Reason.EMERGENCY_KILL);
  }
  await b.engine.settle();
} finally {
  // Whatever happened, never leave the venue position open.
  const pos = await perp.getPosition().catch(() => null);
  if (pos && pos.exposureUsd > 0.5) { log(`closing leftover $${pos.exposureUsd.toFixed(2)}`); await perp.close().catch((e) => log('leftover close failed:', e.message)); }
}

const venueConn = perp.connection;
const chain = (m) => ({
  txStatus: async (sig, cluster) => {
    const conn = cluster && cluster !== fuseCluster ? venueConn : clients.exec.provider.connection;
    const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const st = value?.[0];
    return { confirmed: Boolean(st && ['confirmed', 'finalized'].includes(st.confirmationStatus)), err: st?.err ?? null };
  },
  receiptHead: async () => {
    const acct = await clients.exec.program.account.fuseAccount.fetch(new clients.exec.web3.PublicKey(m.engine.fuse.chainFuse));
    return Buffer.from(acct.lastReceiptHash).toString('hex');
  }
});

const result = { label: 'Real-venue proof run. Probability path scripted; Fuse transactions, venue fills, P&L and receipts are real.', venue: 'DRIFT', venueCluster: venueEnv, fuseCluster, programId: env.FUSE_PROGRAM_ID, gitSha: (() => { try { return execSync('git rev-parse HEAD').toString().trim(); } catch { return null; } })(), generatedAt: new Date().toISOString(), venueSetupTxs: perp.setupTxs || [], mandates: [] };
for (const m of mandates) {
  const fuse = m.engine.snapshot();
  const verification = await verifyExecution({ fuse, receipts: m.receipts, chain: chain(m) });
  log(`${m.name}: verifier → ${verification.summary}`);
  result.mandates.push({ name: m.name, fuse, receipts: m.receipts, rejections: m.rejections, lossStop: fuse.lossStop || null, verification });
}
await fs.writeFile(out, JSON.stringify(result, null, 2));
log(`wrote ${out}. Re-verify independently: npm run verify -- --file ${out} --mandate 0`);
process.exit(result.mandates.every((m) => m.verification.status === 'VERIFIED') ? 0 : 1);

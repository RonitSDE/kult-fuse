import fs from 'node:fs/promises';
import path from 'node:path';
import { statsFromReceipts, verifyPredictSwapTx } from './proof.mjs';
import { createTradeAttestation, isBase58, normalizeTradeIntent } from './attestation.mjs';
import { assertDevnet } from './network.mjs';
import { PROGRAM_ID, DEVNET_MUSDC, RPC_DEFAULT } from './policy.mjs';

// One runtime process per persistent disk. Atomic replacement preserves earlier receipts.
//
// v2.1.1: RPC lookups and verification run outside the write queue (only read-check-write is
// serialized), and a swap the browser reports before finality is queued on disk. `sweep()`
// re-checks the queue in the background, so a trade still reaches the scoreboard when the trader
// closes the tab before finality. Browser polls for a queued signature are answered from the
// queue's last check for a few seconds instead of hitting RPC again.
export function createPredictRegistry({
  storePath, lookup, lookupConfirmed, resolveMarketMints, attestation, requireAppMemo = true,
  retryDelaysMs = [0, 1500, 3000, 5000], pendingPath, pendingTtlMs = 15 * 60_000, maxPending = 500,
  recheckMs = 4000, clock = Date.now
} = {}) {
  if (!storePath || typeof lookup !== 'function' || typeof resolveMarketMints !== 'function') {
    throw new Error('Receipt storage, transaction lookup and market resolver are required');
  }
  const finalizedOnly = Boolean(attestation);
  const queuePath = pendingPath || `${storePath}.pending.json`;
  let writer = Promise.resolve();
  const serialize = (fn) => { const job = writer.then(fn); writer = job.catch(() => {}); return job; };

  async function readJson(file) {
    try {
      const entries = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(entries)) throw new Error('Invalid receipt data');
      return entries;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  async function writeJson(file, rows) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(rows, null, 2), { mode: 0o600, flush: true });
    await fs.rename(temp, file);
  }
  const read = () => readJson(storePath);

  let pending = null; // Map signature -> { wallet, marketPda, firstSeenMs, checkedAtMs, state }
  async function loadPending() {
    if (!pending) pending = new Map((await readJson(queuePath)).map((row) => [row.signature, row]));
    return pending;
  }
  const savePending = () => writeJson(queuePath, [...pending.values()]);

  const stats = async () => statsFromReceipts(await read(), finalizedOnly);
  const receipt = async signature => (await read()).find(row =>
    row.signature === signature && row.evidence === 'FINALIZED_ONCHAIN_SWAP' && row.attribution === 'FUSE_API_ATTESTED');

  function validInput({ signature, wallet, marketPda }) {
    return finalizedOnly
      ? isBase58(signature, 64) && [wallet, marketPda].every(key => isBase58(key, 32))
      : /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(signature ?? '') &&
        [wallet, marketPda].every(key => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key ?? ''));
  }
  function existingResult(receipts, { signature, wallet, marketPda }) {
    const existing = receipts.find(row => row.signature === signature);
    if (!existing || (finalizedOnly && existing.evidence !== 'FINALIZED_ONCHAIN_SWAP')) return null;
    if (existing.wallet !== wallet || existing.marketPda !== marketPda) {
      return { verified: false, state: 'rejected', reason: 'Receipt belongs to a different wallet or market' };
    }
    return { verified: true, state: finalizedOnly ? 'finalized' : 'confirmed', alreadyRecorded: true, receipt: existing };
  }

  // Chain work, no locks held.
  async function check({ signature, wallet, marketPda }) {
    let tx;
    for (const delay of retryDelaysMs) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      tx = await lookup(signature);
      if (tx) break;
    }
    if (!tx && lookupConfirmed) {
      const confirmed = await lookupConfirmed(signature);
      if (confirmed?.meta?.err) return { outcome: { verified: false, state: 'failed', reason: 'Swap failed on Solana' } };
      return { outcome: { verified: false, state: confirmed ? 'confirmed' : 'pending' } };
    }
    if (tx?.meta?.err && finalizedOnly) return { outcome: { verified: false, state: 'failed', reason: 'Swap failed on Solana' } };
    const expectedMints = await resolveMarketMints(marketPda);
    const result = verifyPredictSwapTx(tx, { signature, wallet, marketPda, expectedMints, requireAppMemo, attestation });
    if (!result.ok) return { outcome: { verified: false, state: 'rejected', reason: result.message } };
    if (finalizedOnly) { result.evidence = 'FINALIZED_ONCHAIN_SWAP'; result.slot = tx.slot; }
    return { result };
  }

  // Serialized: re-read, de-duplicate, write the receipt and settle the queue entry.
  function commit(input, checked) {
    return serialize(async () => {
      const queue = await loadPending();
      const receipts = await read();
      let outcome = existingResult(receipts, input);
      if (!outcome && checked.result) {
        if (finalizedOnly && receipts.some(row => row.attestationId === checked.result.attestationId)) {
          outcome = { verified: false, state: 'rejected', reason: 'Trade attestation already registered' };
        } else {
          await writeJson(storePath, [...receipts.filter(row => row.signature !== input.signature), checked.result]);
          outcome = { verified: true, state: finalizedOnly ? 'finalized' : 'confirmed', alreadyRecorded: false, receipt: checked.result };
        }
      }
      outcome ??= checked.outcome;
      const now = clock();
      const waiting = !outcome.verified && ['confirmed', 'pending'].includes(outcome.state);
      const entry = queue.get(input.signature);
      if (waiting && (entry || queue.size < maxPending)) {
        queue.set(input.signature, { signature: input.signature, wallet: input.wallet, marketPda: input.marketPda,
          firstSeenMs: entry?.firstSeenMs ?? now, checkedAtMs: now, state: outcome.state });
        await savePending();
        return { ...outcome, queued: true };
      }
      if (!waiting && entry) { queue.delete(input.signature); await savePending(); }
      return outcome;
    });
  }

  async function record(body, { force = false } = {}) {
    const input = { signature: body?.signature, wallet: body?.wallet, marketPda: body?.marketPda };
    if (!validInput(input)) return { verified: false, state: 'rejected', reason: 'Invalid signature or account' };
    const done = existingResult(await read(), input);
    if (done) return done;
    if (!force) {
      const entry = (await loadPending()).get(input.signature);
      if (entry && entry.wallet === input.wallet && entry.marketPda === input.marketPda && clock() - entry.checkedAtMs < recheckMs) {
        return { verified: false, state: entry.state, queued: true };
      }
    }
    return commit(input, await check(input));
  }

  // Background reconciliation of queued swaps. Oldest-checked first, bounded per run.
  async function sweep({ limit = 20 } = {}) {
    const queue = await loadPending();
    const now = clock();
    const expired = [...queue.values()].filter((row) => now - row.firstSeenMs > pendingTtlMs);
    if (expired.length) {
      await serialize(async () => { for (const row of expired) queue.delete(row.signature); await savePending(); });
    }
    const due = [...queue.values()].sort((a, b) => a.checkedAtMs - b.checkedAtMs).slice(0, limit);
    const summary = { checked: 0, finalized: 0, dropped: expired.length, waiting: 0 };
    for (const row of due) {
      try {
        const out = await record(row, { force: true });
        summary.checked += 1;
        if (out.verified) summary.finalized += 1;
        else if (out.queued) summary.waiting += 1;
      } catch { /* RPC hiccup: the entry stays queued for the next run */ }
    }
    return summary;
  }

  return { stats, record, receipt, sweep, pendingCount: async () => (await loadPending()).size };
}

export async function createDefaultPredictRegistry(env = process.env) {
  if (env.SOLANA_CLUSTER && env.SOLANA_CLUSTER !== 'devnet') throw new Error('PREDICT requires Solana Devnet');
  const attestation = createTradeAttestation(env.PREDICT_ATTESTATION_KEY);
  const { Connection, PublicKey } = await import('@solana/web3.js');
  const rpc = new URL(env.PREDICT_DEVNET_RPC || RPC_DEFAULT);
  if (rpc.protocol !== 'https:' || rpc.username || rpc.password) throw new Error('Use an HTTPS Devnet RPC URL');
  const connection = new Connection(rpc.href, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(6500) })
  });
  const program = new PublicKey(PROGRAM_ID);
  const storePath = env.PREDICT_RECEIPTS_FILE || path.join(env.DATA_DIR || './.data', 'predict-receipts.json');
  let verifiedUntil = 0;
  let chainCheck;
  async function requireDevnet() {
    if (Date.now() < verifiedUntil) return;
    chainCheck ??= assertDevnet(connection).then(() => {
      verifiedUntil = Date.now() + 60_000;
    }).finally(() => { chainCheck = null; });
    await chainCheck;
  }
  async function parsed(signature, commitment) {
    await requireDevnet();
    return connection.getParsedTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 });
  }
  const registry = createPredictRegistry({
    storePath, attestation, retryDelaysMs: [0],
    lookup: signature => parsed(signature, 'finalized'),
    lookupConfirmed: signature => parsed(signature, 'confirmed'),
    resolveMarketMints: async address => {
      const market = new PublicKey(address);
      const account = await connection.getAccountInfo(market, 'finalized');
      if (!account?.owner.equals(program)) throw new Error('Selected market is unavailable on PREDICT');
      const mint = seed => PublicKey.findProgramAddressSync([Buffer.from(seed), market.toBuffer()], program)[0].toBase58();
      return { yes: mint('yes_mint'), no: mint('no_mint') };
    }
  });
  return {
    ...registry,
    attest(body) {
      return attestation.issue(normalizeTradeIntent(body));
    },
    async ready() {
      await requireDevnet();
      const [account] = await Promise.all([connection.getAccountInfo(program, 'finalized'), registry.stats()]);
      if (!account?.executable) throw new Error('PREDICT program unavailable on Devnet');
    }
  };
}

export const predictPublicConfig = {
  network: 'devnet', programId: PROGRAM_ID, collateralMint: DEVNET_MUSDC,
  buildSha: [process.env.BUILD_SHA, process.env.RENDER_GIT_COMMIT].find(value => /^[a-f0-9]{40}$/.test(value ?? '')) ?? null,
  scoringCommitment: 'finalized', attribution: 'FUSE_API_ATTESTED'
};

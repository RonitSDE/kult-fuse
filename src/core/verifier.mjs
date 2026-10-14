import { policyHash, hysteresisTarget } from './policy.mjs';
import { verifyReceiptChain } from './receipt.mjs';

const DETERMINISTIC_REASONS = new Set(['INITIAL_OPEN','PROBABILITY_STEP_UP','PROBABILITY_STEP_DOWN','NOOP']);
const RISK_REDUCING_REASONS = new Set(['LOSS_STOP','EXPIRY_CLOSE','RISK_CAP_CLAMP','EMERGENCY_KILL','KILL_PROBABILITY','RECONCILE']);

function sameOrLowerRisk(expected, submitted) {
  if (submitted === 0) return true;
  if (expected === 0) return false;
  return Math.sign(submitted) === Math.sign(expected) && Math.abs(submitted) <= Math.abs(expected);
}

export function verifyFuse({ fuse, receipts = [] }) {
  const checks = [];
  const computedPolicyHash = policyHash(fuse.policy);
  checks.push({ name: 'Policy commitment', ok: computedPolicyHash === fuse.policyHash, expected: fuse.policyHash, actual: computedPolicyHash });
  checks.push({ name: 'Hard risk cap', ok: Math.abs(fuse.desiredExposureUsd) <= fuse.policy.riskCapUsd, expected: `<= ${fuse.policy.riskCapUsd}`, actual: Math.abs(fuse.desiredExposureUsd) });
  if (fuse.status === 'KILLED') checks.push({ name: 'Absorbing kill target', ok: fuse.desiredExposureUsd === 0, expected: 0, actual: fuse.desiredExposureUsd });

  const chain = verifyReceiptChain(receipts, fuse.policyHash);
  checks.push({ name: 'Receipt hash chain', ok: chain.ok, expected: 'valid', actual: chain.ok ? `${chain.count} receipts` : chain.error });
  if (receipts.length) checks.push({ name: 'Receipt head anchored', ok: chain.lastReceiptHash === fuse.lastReceiptHash, expected: fuse.lastReceiptHash, actual: chain.lastReceiptHash });

  let previousTarget = 0;
  let policyViolations = 0;
  let capViolations = 0;
  let killViolations = 0;
  for (const receipt of receipts) {
    const curve = hysteresisTarget(fuse.policy, receipt.observedProbabilityBps, previousTarget);
    const submitted = Number(receipt.desiredExposureAfterUsd || 0);
    const expected = Number(curve.targetUsd || 0);

    if (Math.abs(submitted) > fuse.policy.riskCapUsd) capViolations += 1;
    if (curve.killed && submitted !== 0) killViolations += 1;

    if (DETERMINISTIC_REASONS.has(receipt.reason)) {
      if (submitted !== expected) policyViolations += 1;
    } else if (receipt.reason === 'KILL_PROBABILITY') {
      if (!(receipt.observedProbabilityBps < fuse.policy.killBelowBps && submitted === 0)) policyViolations += 1;
    } else if (RISK_REDUCING_REASONS.has(receipt.reason)) {
      if (!sameOrLowerRisk(expected, submitted)) policyViolations += 1;
    } else if (!sameOrLowerRisk(expected, submitted) && submitted !== expected) {
      policyViolations += 1;
    }
    previousTarget = submitted;
  }

  checks.push({ name: 'P → E policy execution', ok: policyViolations === 0, expected: '0 violations', actual: `${policyViolations} violations` });
  checks.push({ name: 'Receipt cap compliance', ok: capViolations === 0, expected: '0 breaches', actual: `${capViolations} breaches` });
  checks.push({ name: 'Kill compliance', ok: killViolations === 0, expected: '0 violations', actual: `${killViolations} violations` });

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    checks,
    stats: { receipts: receipts.length, policyViolations, capViolations, killViolations },
    summary: ok ? 'POLICY COMPLIANCE VERIFIED' : 'VERIFICATION FAILED'
  };
}

const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

/**
 * Checks each venue fill against the chain, not against the worker's own word.
 * chain: { txStatus(signature, cluster?) -> { confirmed, err }, receiptHead() -> hex | null } (RPC-backed in production).
 * `cluster` is the venue's cluster from the receipt; null means the Fuse cluster.
 * A fill is VERIFIED only if its venue transaction and its record_fill anchor both confirmed without error,
 * the receipt carries its Fuse state, size, timestamp and residual, and policy checks pass.
 */
export async function verifyExecution({ fuse, receipts = [], chain }) {
  const policy = verifyFuse({ fuse, receipts });
  const fills = receipts.filter((r) => r.txSignature);
  if (!fills.length) {
    return { ...policy, ok: false, status: 'NO_EXECUTION', summary: 'No execution to verify', fills: [] };
  }

  const confirmed = async (sig, cluster = null) => {
    if (!SOLANA_SIGNATURE.test(String(sig || ''))) return { ok: false, why: 'not a Solana signature' };
    try {
      const s = await chain.txStatus(sig, cluster);
      if (!s?.confirmed) return { ok: false, why: 'not found or unconfirmed onchain' };
      if (s.err) return { ok: false, why: `transaction failed: ${JSON.stringify(s.err)}` };
      return { ok: true };
    } catch (e) { return { ok: false, why: `RPC error: ${e.message}` }; }
  };

  const out = [];
  for (const r of fills) {
    const problems = [];
    const venue = await confirmed(r.txSignature, r.venueCluster);
    if (!venue.ok) problems.push(`venue tx ${venue.why}`);
    if (r.anchor?.status !== 'ANCHORED') problems.push(r.anchor?.status === 'FAILED' ? `anchoring failed: ${r.anchor.error}` : 'receipt not anchored onchain');
    else {
      const anchor = await confirmed(r.anchor.signature);
      if (!anchor.ok) problems.push(`anchor tx ${anchor.why}`);
    }
    for (const field of ['fuseStatus', 'timestampMs', 'filledExposureAfterUsd', 'residualUsd']) {
      if (r[field] == null) problems.push(`missing ${field}`);
    }
    out.push({
      hash: r.hash, reason: r.reason, txSignature: r.txSignature, venueCluster: r.venueCluster ?? null, anchorSignature: r.anchor?.signature || null,
      fuseStatus: r.fuseStatus ?? null, timestampMs: r.timestampMs, positionUsd: r.filledExposureAfterUsd,
      residualUsd: r.residualUsd ?? null, unrealizedPnlUsd: r.unrealizedPnlUsd ?? null,
      status: problems.length ? 'UNVERIFIED' : 'VERIFIED', problems
    });
  }

  const checks = [...policy.checks];
  let head = null;
  try { head = await chain.receiptHead(); } catch (e) { head = `RPC error: ${e.message}`; }
  const lastHash = receipts.at(-1)?.hash;
  checks.push({ name: 'Onchain receipt head', ok: head === lastHash, expected: lastHash, actual: head });
  const unverified = out.filter((f) => f.status !== 'VERIFIED').length;
  checks.push({ name: 'Venue fills confirmed and anchored', ok: unverified === 0, expected: `${out.length} verified`, actual: `${out.length - unverified}/${out.length} verified` });

  const policyOk = policy.checks.every((c) => c.ok);
  const ok = checks.every((c) => c.ok);
  const status = ok ? 'VERIFIED' : policyOk ? 'UNVERIFIED' : 'FAILED';
  const summary = ok ? 'Verified' : policyOk ? `Unverified: ${checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}` : 'Verification failed';
  return { ok, status, summary, checks, fills: out, stats: { ...policy.stats, fills: out.length, unverified } };
}

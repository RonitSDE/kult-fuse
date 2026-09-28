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

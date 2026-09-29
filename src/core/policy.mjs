import { sha256Hex } from './canonical.mjs';

export function validatePolicy(policy) {
  if (!policy || policy.version !== 1) throw new Error('policy.version must be 1');
  if (policy.type !== 'STEP') throw new Error('v1 supports STEP curves only');
  if (!Array.isArray(policy.steps) || policy.steps.length === 0) throw new Error('policy.steps required');
  if (policy.steps.length > 5) throw new Error('v1 supports at most 5 onchain-verifiable steps');
  const sorted = [...policy.steps].sort((a, b) => a.pBps - b.pBps);
  if (JSON.stringify(sorted) !== JSON.stringify(policy.steps)) throw new Error('steps must be sorted ascending');
  for (const step of policy.steps) {
    if (!Number.isInteger(step.pBps) || step.pBps < 0 || step.pBps > 10000) throw new Error('invalid pBps');
    if (!Number.isFinite(step.exposureUsd) || step.exposureUsd < 0) throw new Error('invalid exposureUsd');
    if (step.exposureUsd > policy.riskCapUsd) throw new Error('step exceeds riskCapUsd');
  }
  if (!(policy.killBelowBps >= 0 && policy.killBelowBps <= 10000)) throw new Error('invalid killBelowBps');
  if (!(policy.riskCapUsd > 0)) throw new Error('riskCapUsd must be > 0');
  if (!(policy.hysteresisBps >= 0 && policy.hysteresisBps <= 1000)) throw new Error('invalid hysteresisBps');
  if (!(policy.confirmationCount >= 1 && policy.confirmationCount <= 10)) throw new Error('invalid confirmationCount');
  if (!(policy.maxOracleAgeSec >= 1)) throw new Error('invalid maxOracleAgeSec');
  if (!(policy.maxSpreadBps >= 1)) throw new Error('invalid maxSpreadBps');
  return true;
}

export function policyHash(policy) {
  validatePolicy(policy);
  return sha256Hex(policy);
}

export function rawTargetForProbability(policy, pBps) {
  let target = 0;
  for (const step of policy.steps) {
    if (pBps >= step.pBps) target = step.exposureUsd;
    else break;
  }
  return Math.min(target, policy.riskCapUsd);
}

export function stepIndex(policy, pBps) {
  let idx = -1;
  for (let i = 0; i < policy.steps.length; i += 1) {
    if (pBps >= policy.steps[i].pBps) idx = i;
    else break;
  }
  return idx;
}

export function hysteresisTarget(policy, pBps, currentTargetUsd) {
  if (pBps < policy.killBelowBps) return { targetUsd: 0, killed: true, step: -1 };

  const desiredIdx = stepIndex(policy, pBps);
  const currentIdx = policy.steps.findIndex((s) => s.exposureUsd === currentTargetUsd);
  if (currentIdx < 0) {
    return { targetUsd: rawTargetForProbability(policy, pBps), killed: false, step: desiredIdx };
  }

  if (desiredIdx > currentIdx) {
    const nextThreshold = policy.steps[currentIdx + 1]?.pBps;
    if (nextThreshold == null || pBps < nextThreshold + policy.hysteresisBps) {
      return { targetUsd: currentTargetUsd, killed: false, step: currentIdx };
    }
  }

  if (desiredIdx < currentIdx) {
    const currentThreshold = policy.steps[currentIdx]?.pBps ?? 0;
    if (pBps >= currentThreshold - policy.hysteresisBps) {
      return { targetUsd: currentTargetUsd, killed: false, step: currentIdx };
    }
  }

  return { targetUsd: rawTargetForProbability(policy, pBps), killed: false, step: desiredIdx };
}

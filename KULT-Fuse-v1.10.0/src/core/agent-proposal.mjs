import { rawTargetForProbability } from './policy.mjs';
import { FuseStatus } from './constants.mjs';

// This is a *non-executing*, independently testable policy precheck for
// agent-generated intent. Its ALLOW result is not a Solana authorization or
// a trade; execution still needs the normal onchain Fuse transaction.
export function evaluateAgentProposal({ fuse, quote, proposal, nowMs = Date.now() }) {
  const reasons = [];
  const target = proposal?.targetUsd;
  const active = [FuseStatus.ARMED, FuseStatus.OPEN, FuseStatus.REDUCING].includes(fuse?.status);
  if (!active) reasons.push('MANDATE_NOT_ACTIVE');
  if (!fuse?.policy || nowMs / 1000 > fuse.policy.expiryTs) reasons.push('MANDATE_EXPIRED');
  if (!proposal || typeof proposal !== 'object' || proposal.fuseId !== fuse?.id ||
      proposal.policyHash !== fuse?.policyHash) reasons.push('PROPOSAL_BINDING_MISMATCH');
  if (!Number.isSafeInteger(target) || target < 0) reasons.push('INVALID_TARGET');
  if (!quote || quote.quality !== true || !Number.isFinite(quote.probability)) reasons.push('UNTRUSTED_OR_STALE_QUOTE');
  if (!Number.isFinite(proposal?.proposedAtMs) || proposal.proposedAtMs > nowMs + 2000 ||
      nowMs - proposal.proposedAtMs > 120000) reasons.push('EXPIRED_OR_FUTURE_PROPOSAL');
  const permitted = quote?.quality === true && fuse?.policy
    ? rawTargetForProbability(fuse.policy, Math.round(quote.probability * 10000)) : null;
  if (Number.isSafeInteger(target) && fuse?.policy && target > fuse.policy.riskCapUsd) reasons.push('RISK_CAP_EXCEEDED');
  if (Number.isSafeInteger(target) && permitted != null && target > permitted) reasons.push('CURVE_LIMIT_EXCEEDED');
  return {
    verdict: reasons.length ? 'REFUSE' : 'ALLOW_AS_PROPOSAL_ONLY',
    reasons,
    targetUsd: Number.isSafeInteger(target) ? target : null,
    permittedUsd: permitted,
    policyHash: fuse?.policyHash || null,
    source: 'AGENT_PROPOSAL_PRECHECK',
    status: 'NOT_EXECUTED',
    onchainAuthorization: false,
    venueTrade: false,
    explanation: reasons.length ? 'The proposal violates a mandate/precheck constraint; no transaction was initiated.'
      : 'This proposal is within the displayed policy envelope. It has NOT been approved onchain or executed.'
  };
}

// Operational decisions are useful for explaining refusals. They are never
// receipts and must not be presented as onchain or venue execution evidence.
export function makeDecision({ action, fuse, result = null, error = null, position = null, at = Date.now() }) {
  const observed = position?.exposureUsd ?? result?.position?.exposureUsd;
  const actual = observed == null ? null : Number(observed);
  const residual = actual == null ? null : Math.abs(actual);
  const reason = error
    ? (String(error.message || '').includes('oracle replay') ? 'ORACLE_REPLAY'
      : String(fuse.chainWarning || '').includes('not committed onchain') ? 'CHAIN_COMMITMENT_FAILED'
      : 'ACTION_FAILED')
    : action === 'arm' ? 'ARMED'
    : String(result?.reason || fuse.lastReasonCode || action.toUpperCase());
  let outcome = 'HOLD';
  if (fuse.status === 'KILLED' && residual == null) outcome = 'CLOSE_UNKNOWN';
  else if (fuse.status === 'KILLED' && residual >= 0.01) outcome = 'CLOSE_PENDING';
  else if (error) outcome = 'BLOCKED';
  else if (result?.executed && fuse.status === 'KILLED') outcome = 'CLOSED';
  else if (result?.executed) outcome = 'FILLED';
  else if (reason === 'NO_VENUE_FILL') outcome = 'NO_FILL';
  else if (action === 'arm') outcome = 'ARMED';
  else if (fuse.status === 'KILLED') outcome = 'KILLED_FLAT';
  const explanations = {
    ORACLE_STALE: 'Quote too old. No risk increase.',
    ORACLE_WIDE: 'Prediction spread too wide. No risk increase.',
    ORACLE_THIN: 'Insufficient top-of-book depth. No risk increase.',
    AWAITING_CONFIRMATION: 'Waiting for another consistent observation.',
    ORACLE_REPLAY: 'Repeated oracle sequence rejected.',
    CHAIN_COMMITMENT_FAILED: 'Risk increase did not commit on Solana; venue order was not sent.',
    NO_VENUE_FILL: 'Venue order produced no position change. No execution receipt.',
    ACTION_FAILED: 'Action failed. Inspect worker logs before retrying.',
    STATE_KILLED: 'Mandate is killed. No new Fuse target.',
    NOOP: 'Target unchanged; no new venue order needed.'
  };
  const explanation = outcome === 'CLOSE_PENDING'
    ? reason === 'NO_VENUE_FILL'
      ? 'Close attempt did not fill. Venue exposure remains; retry and confirm.'
      : 'Fuse is killed, but venue exposure remains. A separate close must confirm.'
    : outcome === 'CLOSE_UNKNOWN'
      ? 'Fuse is killed. Venue exposure could not be checked; close is unconfirmed.'
    : outcome === 'CLOSED'
      ? 'Venue position reports flat after a close fill. Verify its transaction and Fuse anchor.'
      : outcome === 'FILLED'
        ? 'Venue position changed. Receipt still needs independent verification.'
        : explanations[reason] || (outcome === 'ARMED' ? 'Mandate armed; no venue execution yet.'
          : outcome === 'KILLED_FLAT' ? 'Mandate killed and venue reports flat.'
          : 'No new venue execution.');
  return {
    id: `${fuse.id}:${at}:${fuse.oracleSequence || 0}:${action}`,
    fuseId: fuse.id,
    at,
    action,
    outcome,
    reason,
    explanation,
    probabilityBps: fuse.lastProbabilityBps || null,
    targetUsd: Number(fuse.desiredExposureUsd || 0),
    venueExposureUsd: actual,
    receiptHash: result?.executed ? result.receipt?.hash || null : null,
    venueSignature: result?.executed ? result.exec?.txSignature || null : null,
    anchorStatus: result?.executed ? result.receipt?.anchor?.status || 'NONE' : null,
    evidence: 'WORKER_LOG_ONLY'
  };
}

export function retainDecisions(existing, decision, max = 60) {
  const active=existing.filter((item) => item.fuseId === decision.fuseId);
  const last=active.at(-1);
  if (last && ['HOLD','CLOSE_PENDING','KILLED_FLAT'].includes(decision.outcome)
    && last.outcome === decision.outcome && last.reason === decision.reason
    && last.targetUsd === decision.targetUsd && last.venueExposureUsd === decision.venueExposureUsd
    && decision.at - last.at < 30000) {
    active[active.length-1]={...last,at:decision.at,repeatCount:(last.repeatCount||1)+1};
    return active.slice(-max);
  }
  return [...active, decision].slice(-max);
}

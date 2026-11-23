// Presentation state only. These examples NEVER authorize or submit a trade.
export function isSyntheticState(s) {
  const tag = String(s?.integrity?.buildTag || '').toLowerCase();
  const sha = String(s?.integrity?.buildSha || '').toUpperCase();
  return s?.integrity?.mode === 'synthetic' || tag.includes('preview') || sha.includes('SYNTHETIC') || s?.market?.ticker === 'PREVIEW-TICKER';
}

export const DEMO_LABELS = Object.freeze([
  'Inside the mandate',
  'Over the hard cap',
  'Owner triggers kill',
  'Agent tries to reopen'
]);

export function permittedByCurve(policy, pBps) {
  if (!policy || !Number.isFinite(pBps)) return 0;
  if (pBps < policy.killBelowBps) return 0;
  let result = 0;
  for (const step of policy.steps || []) {
    if (pBps >= step.pBps) result = step.exposureUsd;
    else break;
  }
  return Math.min(result, policy.riskCapUsd);
}

export function demoSnapshot(policy, index) {
  if (!policy || !Number.isInteger(index) || index < 0 || index >= DEMO_LABELS.length) throw new RangeError('Invalid demo step');
  const steps = [...policy.steps].sort((a, b) => a.pBps - b.pBps);
  const middle = steps[Math.max(0, steps.length - 2)] || steps[0];
  const high = steps[steps.length - 1];
  const permittedBps = Math.max(policy.killBelowBps, middle?.pBps ?? 6000);
  const highBps = Math.max(policy.killBelowBps, high?.pBps ?? 8000);
  const pBps = index === 2 ? Math.max(0, policy.killBelowBps - 100) : index === 0 ? permittedBps : highBps;
  const curvePermitted = permittedByCurve(policy, pBps);
  const killed = index >= 2;
  const permitted = killed ? 0 : curvePermitted;
  const requested = index === 1 ? policy.riskCapUsd + 20 : index === 3 ? Math.max(1, curvePermitted) : index === 0 ? Math.max(0, curvePermitted) : 0;
  const refused = index === 1 || index === 3;
  const titles = [
    'ALLOW AS PROPOSAL · not executed',
    'REFUSE · hard cap exceeded',
    'KILL · target becomes zero',
    'REFUSE · killed mandates cannot reopen'
  ];
  const details = [
    `A hypothetical ${requested} USD request is within the permitted ${permitted} USD curve. It still needs live checks and onchain approval. No trade was sent.`,
    `The hypothetical agent asks for ${requested} USD, above the owner's ${policy.riskCapUsd} USD hard cap. No trade was sent.`,
    `Below ${policy.killBelowBps / 100}%, the policy target is zero. A real venue close must be separately signed, filled and verified. No close was sent.`,
    'Even after the probability recovers, this example mandate remains killed. The attempted increase is refused; no trade was sent.'
  ];
  return {
    index, label: DEMO_LABELS[index], probability: pBps / 10000, requested,
    permitted, refused, killed, title: titles[index], detail: details[index],
    reason: ['WITHIN_CURVE', 'RISK_CAP_EXCEEDED', 'KILL_LINE', 'MANDATE_KILLED'][index],
    venueExecution: false, anchor: false, mode: 'SIMULATION_NOT_EXECUTED'
  };
}

export function thresholdRows(policy, p) {
  if (!policy) return [];
  const rows = [{ atBps: 0, label: `Below ${policy.killBelowBps / 100}%`, usd: 0, kind: 'kill', active: Number.isFinite(p) && p * 10000 < policy.killBelowBps }];
  for (const step of policy.steps || []) {
    if (step.pBps < policy.killBelowBps) continue;
    rows.push({ atBps: step.pBps, label: `At ${step.pBps / 100}% or above`, usd: Math.min(step.exposureUsd, policy.riskCapUsd), kind: 'step', active: false });
  }
  if (Number.isFinite(p) && p * 10000 >= policy.killBelowBps) {
    const active = [...rows].filter((r) => r.kind === 'step' && r.atBps <= p * 10000).at(-1);
    if (active) active.active = true;
  }
  return rows;
}

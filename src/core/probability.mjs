import { rawTargetForProbability } from './policy.mjs';

export function makeProbabilityMark({ bid, ask, bidDepthUsd = null, askDepthUsd = null, observedAtMs = Date.now(), sequence = 0, source = 'unknown' }, policy, nowMs = Date.now()) {
  const b = Number(bid);
  const a = Number(ask);
  if (!Number.isFinite(b) || !Number.isFinite(a)) throw new Error('bid/ask required');
  if (b < 0 || a > 1 || b > a) throw new Error('invalid bid/ask');

  const p = (b + a) / 2;
  const spread = a - b;
  const midpoint = Math.max(p, 0.0001);
  const spreadBps = Math.round((spread / midpoint) * 10000);
  const ageSec = Math.max(0, (nowMs - observedAtMs) / 1000);
  const pBps = Math.round(p * 10000);
  // Top-of-book depth is optional: sources that do not report it are judged on age and spread only.
  const depthUsd = bidDepthUsd == null || askDepthUsd == null ? null : Math.min(Number(bidDepthUsd), Number(askDepthUsd));
  const minDepth = Number(policy.minTopDepthUsd || 0);
  const qualityReason = ageSec > policy.maxOracleAgeSec ? 'STALE'
    : spreadBps > policy.maxSpreadBps ? 'WIDE'
    : minDepth > 0 && (depthUsd == null || depthUsd < minDepth) ? 'THIN'
    : 'OK';

  return {
    pBps,
    probability: p,
    bid: b,
    ask: a,
    spreadBps,
    ageSec,
    depthUsd,
    observedAtMs,
    sequence,
    source,
    quality: qualityReason === 'OK',
    qualityReason
  };
}

// Plain-language reason the quote does or does not change the permitted exposure.
export function explainSignal(mark, policy, currentTargetUsd = 0) {
  const p = (mark.pBps / 100).toFixed(1);
  const age = `${mark.ageSec.toFixed(0)}s old (max ${policy.maxOracleAgeSec}s)`;
  const spread = `spread ${mark.spreadBps} bps (max ${policy.maxSpreadBps})`;
  const hold = `No increase: permitted exposure stays at most $${currentTargetUsd}.`;
  if (mark.qualityReason === 'STALE') return `Quote is ${age}. ${hold}`;
  if (mark.qualityReason === 'WIDE') return `Quote ${spread} is too wide to trust. ${hold}`;
  if (mark.qualityReason === 'THIN') return `Top of book ${mark.depthUsd == null ? 'depth is unavailable' : `holds $${mark.depthUsd.toFixed(0)}`} (min $${policy.minTopDepthUsd}). ${hold}`;
  if (mark.pBps < policy.killBelowBps) return `${p}% is under the ${policy.killBelowBps / 100}% kill line: target $0, mandate killed.`;
  const step = rawTargetForProbability(policy, mark.pBps);
  return `${p}% mid, ${age}, ${spread}: the committed curve permits $${step}.`;
}

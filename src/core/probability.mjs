export function makeProbabilityMark({ bid, ask, observedAtMs = Date.now(), sequence = 0, source = 'unknown' }, policy, nowMs = Date.now()) {
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
  const quality = ageSec <= policy.maxOracleAgeSec && spreadBps <= policy.maxSpreadBps;

  return {
    pBps,
    probability: p,
    bid: b,
    ask: a,
    spreadBps,
    ageSec,
    observedAtMs,
    sequence,
    source,
    quality,
    qualityReason: ageSec > policy.maxOracleAgeSec ? 'STALE' : spreadBps > policy.maxSpreadBps ? 'WIDE' : 'OK'
  };
}

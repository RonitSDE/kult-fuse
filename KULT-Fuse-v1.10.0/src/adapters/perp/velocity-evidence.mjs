// Derive fill evidence from the venue transaction, independently of the worker receipt.
// The receipt's self-reported before/after position is checked against the decoded
// OrderActionRecord events. Velocity's IDL is Anchor 1.0 (snake_case fields, PascalCase
// variants); the SDK coder may camelCase them, so names are compared case- and
// underscore-insensitively.
const key = (value) => typeof value?.toBase58 === 'function' ? value.toBase58() : String(value ?? '');
const norm = (s) => String(s).replace(/_/g, '').toLowerCase();
const field = (obj, name) => {
  if (!obj || typeof obj !== 'object') return undefined;
  const want = norm(name);
  for (const k of Object.keys(obj)) if (norm(k) === want) return obj[k];
  return undefined;
};
const variant = (value) => {
  if (value == null) return null;
  if (typeof value === 'string') return norm(value);
  if (typeof value === 'object') { const k = Object.keys(value)[0]; return k ? norm(k) : null; }
  return null;
};
const amount = (v) => Number(v?.toString?.() ?? v ?? 0);

export function summarizeVelocityFills(events, { user, marketIndex, basePrecision = 1e9 }) {
  let deltaBase = 0;
  let count = 0;
  for (const ev of events || []) {
    const name = ev?.name ?? ev?.eventType;
    const data = ev?.data ?? ev;
    if (norm(name) !== 'orderactionrecord') continue;
    if (variant(field(data, 'action')) !== 'fill' || variant(field(data, 'marketType')) !== 'perp') continue;
    if (Number(field(data, 'marketIndex')) !== Number(marketIndex)) continue;
    const filled = amount(field(data, 'baseAssetAmountFilled')) / basePrecision;
    if (!Number.isFinite(filled) || filled <= 0) continue;
    for (const role of ['taker', 'maker']) {
      if (key(field(data, role)) !== user) continue;
      const direction = variant(field(data, `${role}OrderDirection`));
      if (direction !== 'long' && direction !== 'short') continue;
      deltaBase += direction === 'long' ? filled : -filled;
      count += 1;
    }
  }
  return { count, deltaBase };
}

export async function velocityVenueEvidence({ connection, parse, programId, user, marketIndex, signature, receipt, toleranceBase = 1e-8 }) {
  if (receipt?.baseAmountBefore == null || receipt?.baseAmountAfter == null) return { ok: false, why: 'receipt lacks position base amounts' };
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err || !Array.isArray(tx.meta?.logMessages)) return { ok: false, why: 'venue transaction missing, failed, or has no logs' };
  const message = tx.transaction.message;
  const accountKeys = [...(message.staticAccountKeys || message.accountKeys || []), ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])];
  if (!accountKeys.some((k) => key(k) === programId)) return { ok: false, why: 'transaction does not invoke the Velocity program' };
  if (!accountKeys.some((k) => key(k) === user)) return { ok: false, why: 'transaction does not reference the expected venue account' };
  const fill = summarizeVelocityFills(parse(tx.meta.logMessages), { user, marketIndex });
  const claimedDelta = Number(receipt.baseAmountAfter) - Number(receipt.baseAmountBefore);
  if (!fill.count || Math.abs(fill.deltaBase - claimedDelta) > toleranceBase) {
    return { ok: false, why: `venue fills ${fill.count}; onchain base delta ${fill.deltaBase}; receipt delta ${claimedDelta}` };
  }
  return { ok: true, fills: fill.count, deltaBase: fill.deltaBase, slot: tx.slot };
}

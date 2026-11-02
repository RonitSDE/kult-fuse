// Derive fill evidence from the venue transaction, independently of the worker receipt.
// The receipt's self-reported before/after position is checked against the decoded event.
const key = (value) => typeof value?.toBase58 === 'function' ? value.toBase58() : String(value ?? '');
const positive = (value) => Number(value?.toString?.() ?? 0);
const isFill = (action) => action && typeof action === 'object' && Object.hasOwn(action, 'fill');
const isPerp = (type) => type && typeof type === 'object' && Object.hasOwn(type, 'perp');

export function summarizeDriftFills(events, { user, marketIndex }) {
  let deltaBase = 0;
  let count = 0;
  for (const { name, data } of events) {
    if (name !== 'OrderActionRecord' || !isFill(data?.action) || !isPerp(data.marketType) || data.marketIndex !== marketIndex) continue;
    const amount = positive(data.baseAssetAmountFilled) / 1e9;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    for (const role of ['taker', 'maker']) {
      if (key(data[role]) !== user) continue;
      const direction = data[`${role}OrderDirection`];
      if (!direction || (!Object.hasOwn(direction, 'long') && !Object.hasOwn(direction, 'short'))) continue;
      deltaBase += Object.hasOwn(direction, 'long') ? amount : -amount;
      count += 1;
    }
  }
  return { count, deltaBase };
}

export async function driftVenueEvidence({ connection, program, user, marketIndex, signature, receipt, toleranceBase = 1e-8 }) {
  if (receipt?.baseAmountBefore == null || receipt?.baseAmountAfter == null) return { ok: false, why: 'receipt lacks position base amounts' };
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err || !Array.isArray(tx.meta?.logMessages)) return { ok: false, why: 'venue transaction missing, failed, or has no logs' };
  const accountKeys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys || [];
  if (!accountKeys.some((k) => key(k) === key(program.programId))) return { ok: false, why: 'transaction does not invoke the expected venue program' };
  if (!accountKeys.some((k) => key(k) === user)) return { ok: false, why: 'transaction does not reference the expected venue account' };
  const { EventParser } = await import('@coral-xyz/anchor');
  const events = [...new EventParser(program.programId, program.coder).parseLogs(tx.meta.logMessages)];
  const fill = summarizeDriftFills(events, { user, marketIndex });
  const claimedDelta = Number(receipt.baseAmountAfter) - Number(receipt.baseAmountBefore);
  if (!fill.count || Math.abs(fill.deltaBase - claimedDelta) > toleranceBase) {
    return { ok: false, why: `venue fills ${fill.count}; onchain base delta ${fill.deltaBase}; receipt delta ${claimedDelta}` };
  }
  return { ok: true, fills: fill.count, deltaBase: fill.deltaBase, slot: tx.slot };
}

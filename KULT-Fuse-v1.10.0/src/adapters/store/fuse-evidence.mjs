// Read-only proof of a receipt anchor. A confirmed signature alone proves neither
// that it called Fuse nor that it committed this receipt to this mandate.
const key = (x) => typeof x?.toBase58 === 'function' ? x.toBase58() : String(x ?? '');
const hex = (x) => Buffer.from(x ?? []).toString('hex');

export function matchingFillRecord(events, { fusePda, receipt }) {
  return events.some(({ name, data }) => name === 'FillRecorded'
    && key(data?.fuse) === fusePda
    && hex(data?.receiptHash) === receipt.hash
    && Number(data?.executionNonce?.toString?.()) === Number(receipt.sequence)
    && Number(data?.filledExposureUsd?.toString?.()) === Math.round(Number(receipt.filledExposureAfterUsd)));
}

export async function fuseFillEvidence({ connection, program, fusePda, signature, receipt }) {
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err || !Array.isArray(tx.meta?.logMessages)) return { ok: false, why: 'anchor transaction missing, failed, or has no logs' };
  const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys || [];
  if (!keys.some((k) => key(k) === key(program.programId)) || !keys.some((k) => key(k) === fusePda)) {
    return { ok: false, why: 'anchor references a different program or mandate' };
  }
  const { EventParser } = await import('@coral-xyz/anchor');
  const events = [...new EventParser(program.programId, program.coder).parseLogs(tx.meta.logMessages)];
  if (!matchingFillRecord(events, { fusePda, receipt })) return { ok: false, why: 'no matching FillRecorded event for receipt hash, nonce, position and Fuse account' };
  return { ok: true, slot: tx.slot };
}

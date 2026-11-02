import { sha256Hex } from './canonical.mjs';

export function createReceipt(fields) {
  const receipt = {
    version: 1,
    fuseId: fields.fuseId,
    sequence: fields.sequence,
    prevReceiptHash: fields.prevReceiptHash || ''.padStart(64, '0'),
    observedProbabilityBps: fields.observedProbabilityBps,
    desiredExposureBeforeUsd: fields.desiredExposureBeforeUsd,
    desiredExposureAfterUsd: fields.desiredExposureAfterUsd,
    actualExposureBeforeUsd: fields.actualExposureBeforeUsd,
    filledExposureAfterUsd: fields.filledExposureAfterUsd,
    baseAmountBefore: fields.baseAmountBefore ?? null,
    baseAmountAfter: fields.baseAmountAfter ?? null,
    marketId: fields.marketId ?? null,
    markPrice: fields.markPrice,
    reason: fields.reason,
    venue: fields.venue,
    venueRef: fields.venueRef || null,
    // Which Solana cluster the venue transaction lives on; the Fuse anchor may be on another.
    venueCluster: fields.venueCluster ?? null,
    txSignature: fields.txSignature || null,
    // Fuse state, venue P&L (fees included) and target-minus-filled residual at the moment of the fill.
    fuseStatus: fields.fuseStatus ?? null,
    unrealizedPnlUsd: fields.unrealizedPnlUsd ?? null,
    residualUsd: fields.residualUsd ?? null,
    policyHash: fields.policyHash,
    timestampMs: fields.timestampMs || Date.now()
  };
  return { ...receipt, hash: sha256Hex(receipt) };
}

export function verifyReceiptChain(receipts, expectedPolicyHash) {
  let prev = ''.padStart(64, '0');
  for (let i = 0; i < receipts.length; i += 1) {
    const r = receipts[i];
    if (r.prevReceiptHash !== prev) return { ok: false, index: i, error: 'prevReceiptHash mismatch' };
    if (r.policyHash !== expectedPolicyHash) return { ok: false, index: i, error: 'policyHash mismatch' };
    // `chain` and `anchor` hold onchain results added after hashing; they are not part of the committed body.
    const { hash, chain, anchor, ...body } = r;
    if (sha256Hex(body) !== hash) return { ok: false, index: i, error: 'receipt hash mismatch' };
    prev = hash;
  }
  return { ok: true, count: receipts.length, lastReceiptHash: prev };
}

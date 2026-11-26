// Pure checks used by scripts/predict-submission-check.mjs, kept here so they can be unit tested.
import { DEVNET_MUSDC } from './policy.mjs';

export function tokenDelta(tx, wallet, tokenMint) {
  const sum = balances => (balances ?? []).filter(row => row.owner === wallet && row.mint === tokenMint)
    .reduce((amount, row) => amount + BigInt(row.uiTokenAmount.amount), 0n);
  return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
}

/**
 * A finalized Fuse sell for the featured market, checked independently of the buys:
 * direction YesToUsdc (2) or NoToUsdc (3); exactly the instruction's token amount leaves the
 * wallet; the other outcome is untouched; at least the signed minimum of mUSDC arrives; it
 * landed after launch and before the market closed; and the public scoreboard receipt agrees.
 *
 * @param {object} a
 * @param {object} a.tx parsed finalized transaction
 * @param {Buffer} a.data swap instruction data (8-byte discriminator, u8 direction, u64 amountIn, u64 minOut)
 * @param {string} a.wallet instruction signer
 * @param {{marketPda:string, yesMint:string, noMint:string, endTs:number}} a.market
 * @param {number} a.launchSlot
 * @param {object} a.receipt the app's /api/predict/receipts/<signature> response
 */
export function verifySellEvidence({ tx, data, wallet, market, launchSlot, receipt }) {
  const fail = message => { throw new Error(message); };
  if (data.length !== 25 || ![2, 3].includes(data[8])) fail('Sell must be a YES→mUSDC or NO→mUSDC PREDICT swap');
  if (tx.slot < launchSlot) fail('Sell preceded the market launch');
  if (!Number.isSafeInteger(tx.blockTime) || tx.blockTime >= market.endTs) fail('Sell must land before the market closes');
  const side = data[8] === 2 ? 'yes' : 'no';
  const amountRaw = data.readBigUInt64LE(9);
  const minOutRaw = data.readBigUInt64LE(17);
  const outcomeMint = side === 'yes' ? market.yesMint : market.noMint;
  const otherMint = side === 'yes' ? market.noMint : market.yesMint;
  const receivedRaw = tokenDelta(tx, wallet, DEVNET_MUSDC);
  if (amountRaw <= 0n || tokenDelta(tx, wallet, outcomeMint) !== -amountRaw || tokenDelta(tx, wallet, otherMint) !== 0n ||
      receivedRaw <= 0n || receivedRaw < minOutRaw) fail('Sell token movements did not match');
  const receiptReceivedRaw = receipt?.mUsdcReceivedRaw ?? String(Math.round(Number(receipt?.received) * 1e6));
  if (receipt?.signature !== tx.transaction.signatures[0] || receipt.marketPda !== market.marketPda ||
      receipt.action !== 'sell' || receipt.side !== side || receipt.wallet !== wallet || receipt.outcomeMint !== outcomeMint ||
      receiptReceivedRaw !== receivedRaw.toString() || receipt.slot !== tx.slot ||
      receipt.evidence !== 'FINALIZED_ONCHAIN_SWAP' || receipt.attribution !== 'FUSE_API_ATTESTED') {
    fail('Public scoreboard receipt did not match the finalized sell');
  }
  return { side, wallet, amountRaw, receivedRaw, slot: tx.slot };
}

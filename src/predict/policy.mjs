/** PREDICT-first application mandate checks. These are APP-SIDE checks, not onchain delegation. */
export const PROGRAM_ID = 'GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y';
export const DEVNET_MUSDC = '3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ';
export const RPC_DEFAULT = 'https://api.devnet.solana.com';

export function safeBudget(value, label = 'amount') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10000 || Math.round(value * 1e6) !== value * 1e6) {
    // Round-trip tolerance: JS floats like 0.29 can have representational error.
    if (!(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10000 && Math.abs(Math.round(value * 1e6) - value * 1e6) < 0.00001)) throw new Error(`Invalid ${label}`);
  }
  return Math.round(value * 1e6);
}
export function evaluatePrediction({ mandate, proposal, market, nowMs = Date.now() }) {
  const refuse = (reason) => ({ status:'REFUSE', reason, executed:false });
  if (!mandate || !proposal || !market) return refuse('Incomplete mandate, market or proposal');
  if (mandate.killed) return refuse('This browser session is paused');
  if (!proposal.wallet || !mandate.wallet) return refuse('Create and authorize a devnet wallet first');
  if (mandate.wallet !== proposal.wallet) return refuse('Wallet changed: reauthorize mandate');
  if (mandate.marketPda !== proposal.marketPda || market.marketPda !== proposal.marketPda) return refuse('Market outside approved mandate');
  if (proposal.side !== 'yes' && proposal.side !== 'no') return refuse('Invalid prediction side');
  if (mandate.side !== 'either' && mandate.side !== proposal.side) return refuse('Side not approved');
  if (Number.isFinite(mandate.expiresAtMs) && nowMs >= mandate.expiresAtMs) return refuse('Mandate expired');
  if (market.resolved || market.endTs * 1000 <= nowMs) return refuse('Market expired or resolved');
  if (!Number.isFinite(market.observedAtMs) || nowMs - market.observedAtMs > 30_000 || market.observedAtMs > nowMs + 2000) return refuse('Stale/future onchain market observation');
  if (!Number.isFinite(proposal.amount) || proposal.amount <= 0 || proposal.amount > 10000) return refuse('Invalid trade amount');
  if (!Number.isFinite(mandate.maxSingle) || proposal.amount > mandate.maxSingle + 1e-8) return refuse('Above per-trade spending cap');
  if (!Number.isFinite(mandate.maxTotal) || !Number.isFinite(mandate.spent) || proposal.amount + mandate.spent > mandate.maxTotal + 1e-8) return refuse('Session spending cap exceeded');
  if (!Number.isInteger(mandate.maxSlippageBps) || mandate.maxSlippageBps < 10 || mandate.maxSlippageBps > 300) return refuse('Slippage limit must be 10–300 bps');
  if (!Number.isFinite(market.price) || market.price <= 0 || market.price >= 1) return refuse('Invalid onchain market price');
  if (!Number.isInteger(proposal.minOutRaw) || proposal.minOutRaw < 1) return refuse('No validated executable quote');
  if (proposal.quoteMarketPda !== proposal.marketPda || !Number.isFinite(proposal.quoteAtMs) || nowMs - proposal.quoteAtMs > 15_000 || proposal.quoteAtMs > nowMs + 2000) return refuse('Quote expired or for a different market');
  return { status:'ALLOW_AS_APP_CHECK', reason:'Within owner-selected application limits; wallet signature still required', executed:false };
}

export function normalizeMarketAccount({ pda, raw, price, observedAtMs = Date.now() }) {
  const decodeName = (bytes) => {
    if (typeof bytes === 'string') return bytes;
    try { return new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\0/g,'').trim(); } catch { return 'Unnamed market'; }
  };
  const toNum = v => typeof v?.toNumber === 'function' ? v.toNumber() : Number(v);
  return {
    marketPda:String(pda), marketId:toNum(raw.marketId), name:decodeName(raw.name),
    endTs:toNum(raw.endTs), price:Number(price), resolved:Boolean(raw.resolved),
    winningSide:toNum(raw.winningSide), yesMint:raw.yesMint?.toString?.(), noMint:raw.noMint?.toString?.(),
    observedAtMs
  };
}

export function txExplorer(signature) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(signature)) return null;
  return `https://solscan.io/tx/${signature}?cluster=devnet`;
}

/**
 * Runs after the wallet popup returns a signature and before broadcast. The user can switch
 * wallet, pause the session, or let it expire while the popup is open, so the pre-popup check
 * is not enough. Quote age is not rechecked here: the signed minimum output is enforced onchain.
 * Buys need a live, unpaused session for this wallet and market with budget left.
 * Sells spend no budget, but a paused session still stops them.
 */
export function recheckBeforeBroadcast({ action = 'buy', mandate, wallet, activeWallet, signer, marketPda, amount, market, nowMs = Date.now() }) {
  const refuse = (reason) => ({ ok: false, reason });
  if (!wallet || activeWallet !== wallet) return refuse('Wallet changed while the approval was open. Nothing was sent.');
  if (signer !== wallet) return refuse('A different wallet signed. Nothing was sent.');
  if (market && (market.resolved || market.endTs * 1000 <= nowMs)) return refuse('Market closed while the approval was open. Nothing was sent.');
  if (mandate?.killed && (!Number.isFinite(mandate.expiresAtMs) || nowMs < mandate.expiresAtMs) && mandate.wallet === wallet) {
    return refuse('Session paused while the approval was open. Nothing was sent.');
  }
  if (action === 'sell') return { ok: true };
  if (!mandate || mandate.wallet !== wallet) return refuse('No approved session for this wallet. Nothing was sent.');
  if (mandate.marketPda !== marketPda) return refuse('Session limits now cover a different market. Nothing was sent.');
  if (!Number.isFinite(mandate.expiresAtMs) || nowMs >= mandate.expiresAtMs) return refuse('Session expired while the approval was open. Nothing was sent.');
  if (!Number.isFinite(mandate.spent) || amount + mandate.spent > mandate.maxTotal + 1e-8) return refuse('Session budget used up while the approval was open. Nothing was sent.');
  if (amount > mandate.maxSingle + 1e-8) return refuse('Per-trade cap changed. Nothing was sent.');
  return { ok: true };
}

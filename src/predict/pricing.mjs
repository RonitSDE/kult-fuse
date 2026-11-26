// pm-AMM pricing state for quoting, shared by the browser app and tests.
// The program stores reserves as of `lastAccrualTs` and accrues before every swap; reserves scale
// with L_eff = L0·√(T−t) (pm_amm accrual.rs), so they are rescaled to "now" before pricing.
const num = (v) => (typeof v?.toNumber === 'function' ? v.toNumber() : Number(v));

export function accrualScale(endTs, lastAccrualTs, nowSec) {
  const remainingNow = Math.max(endTs - nowSec, 1);
  const remainingLast = Math.max(endTs - (Number.isFinite(lastAccrualTs) ? lastAccrualTs : nowSec), 1);
  return { remainingNow, scale: Math.sqrt(Math.min(1, remainingNow / remainingLast)) };
}

/** @param math { i80f48ToNumber, priceFromReserves } from @pm-amm/sdk/math */
export function marketState(m, math, nowSec = Math.floor(Date.now() / 1000)) {
  const { remainingNow, scale } = accrualScale(num(m.endTs), num(m.lastAccrualTs), nowSec);
  const lZero = math.i80f48ToNumber(m.lZero);
  const x = math.i80f48ToNumber(m.reserveYes) * scale;
  const y = math.i80f48ToNumber(m.reserveNo) * scale;
  const lEff = lZero * Math.sqrt(remainingNow);
  if (!Number.isFinite(lEff) || lEff <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Unavailable pm-AMM liquidity state');
  return { x, y, lEff, price: math.priceFromReserves(x, y, lEff), seconds: remainingNow };
}

// Exact sell on the pm-AMM curve, in raw units. Selling YES adds `amount` to the YES reserve side
// of the invariant: u' = (y − x − amount) / L, the NO reserve becomes L·g(u') with
// g(u) = u·Φ(u) + φ(u), and the gross USDC out is the drop in y. Selling NO is the mirror case.
// The SDK only estimates buys; this inversion was round-trip tested against its buy estimate.
/** @param math { phi, capitalPhi } from @pm-amm/sdk/math */
export function sellGross({ x, y, lEff }, amountRaw, side, math) {
  if (!(lEff > 0) || !(amountRaw > 0)) return 0;
  const g = (u) => u * math.capitalPhi(u) + math.phi(u);
  if (side === 'yes') {
    const u = (y - x - amountRaw) / lEff;
    return Math.max(0, y - lEff * g(u));
  }
  const u = (y - x + amountRaw) / lEff;
  return Math.max(0, x - lEff * (g(u) - u));
}

/** Net mUSDC (raw) the seller receives: the program takes floor(gross·2%) from the curve output. */
export function sellQuote(state, side, amountRaw, math) {
  const grossRaw = Math.floor(sellGross(state, amountRaw, side, math));
  const feeRaw = Math.floor(grossRaw * 200 / 10_000);
  return { grossRaw, feeRaw, netRaw: grossRaw - feeRaw };
}

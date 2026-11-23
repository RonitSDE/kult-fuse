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

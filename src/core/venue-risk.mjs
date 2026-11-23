// Operational risk check at the venue boundary, NOT an onchain or venue-enforced
// risk limit. A compromised worker or delegated trading key may bypass it.
export function assertCollateralizedIncrease({ desiredExposureUsd, collateralUsd, maxLeverageBps }) {
  const target = Number(desiredExposureUsd);
  const collateral = Number(collateralUsd);
  const leverage = Number(maxLeverageBps);
  if (!Number.isFinite(target) || target < 0 || !Number.isFinite(collateral) || collateral <= 0 ||
      !Number.isSafeInteger(leverage) || leverage <= 0) {
    throw new Error('COLLATERAL_UNAVAILABLE: invalid target, collateral or leverage configuration');
  }
  const permittedUsd = collateral * leverage / 10000;
  if (target > permittedUsd + 0.001) {
    throw new Error(`LEVERAGE_LIMIT: target $${target} exceeds collateral-based limit $${permittedUsd.toFixed(2)}`);
  }
  return { permittedUsd, targetUsd: target, collateralUsd: collateral, leverageBps: leverage };
}

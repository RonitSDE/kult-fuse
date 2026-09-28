import { FuseStatus, Reason } from './constants.mjs';

export function evaluateRisk({ fuse, proposedTargetUsd, nowSec = Math.floor(Date.now() / 1000), unrealizedPnlUsd = 0 }) {
  let targetUsd = Number(proposedTargetUsd);
  let reason = null;
  let kill = false;

  if (fuse.status === FuseStatus.KILLED) return { targetUsd: 0, kill: true, reason: Reason.KILL_PROBABILITY };
  if (fuse.status === FuseStatus.SETTLED) return { targetUsd: 0, kill: false, reason: Reason.SETTLEMENT };

  if (nowSec > fuse.policy.expiryTs) {
    const current = Number(fuse.filledExposureUsd || 0);
    if (Math.abs(targetUsd) > Math.abs(current)) targetUsd = current;
    if (Math.sign(targetUsd) !== Math.sign(current) && current !== 0) targetUsd = 0;
    reason = Reason.EXPIRY_CLOSE;
  }

  if (Math.abs(targetUsd) > fuse.policy.riskCapUsd) {
    targetUsd = Math.sign(targetUsd || 1) * fuse.policy.riskCapUsd;
    reason = Reason.RISK_CAP_CLAMP;
  }

  if (fuse.policy.lossStopUsd > 0 && unrealizedPnlUsd <= -Math.abs(fuse.policy.lossStopUsd)) {
    targetUsd = 0;
    kill = true;
    reason = Reason.LOSS_STOP;
  }

  return { targetUsd, kill, reason };
}

export function stressSizedCap({ userCapUsd, lossBudgetUsd, stressMoveBps }) {
  if (!(stressMoveBps > 0)) return userCapUsd;
  const move = stressMoveBps / 10000;
  return Math.min(userCapUsd, lossBudgetUsd / move);
}

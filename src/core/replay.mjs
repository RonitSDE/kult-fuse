import { hysteresisTarget } from './policy.mjs';
import { Reason } from './constants.mjs';

export function replayPolicy(policy, probabilitiesBps) {
  let target = 0;
  let killed = false;
  const rows = [];
  for (let i = 0; i < probabilitiesBps.length; i += 1) {
    const pBps = probabilitiesBps[i];
    const before = target;
    if (killed) {
      target = 0;
      rows.push({ i, pBps, before, after: 0, delta: -before, status: 'KILLED', reason: Reason.KILL_PROBABILITY });
      continue;
    }
    const r = hysteresisTarget(policy, pBps, target);
    target = r.targetUsd;
    if (r.killed) killed = true;
    let reason = Reason.NOOP;
    if (r.killed) reason = Reason.KILL_PROBABILITY;
    else if (target > before) reason = before === 0 ? Reason.INITIAL_OPEN : Reason.PROBABILITY_STEP_UP;
    else if (target < before) reason = Reason.PROBABILITY_STEP_DOWN;
    rows.push({ i, pBps, before, after: target, delta: target - before, status: killed ? 'KILLED' : 'ACTIVE', reason });
  }
  return rows;
}

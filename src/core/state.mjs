import { ALLOWED_TRANSITIONS, FuseStatus } from './constants.mjs';

export function assertTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed?.has(to)) throw new Error(`illegal transition ${from} -> ${to}`);
}

export function transition(fuse, to) {
  assertTransition(fuse.status, to);
  return { ...fuse, status: to, updatedAt: Date.now() };
}

export function assertCanIncreaseRisk(fuse, nowSec = Math.floor(Date.now() / 1000)) {
  if (fuse.status === FuseStatus.KILLED || fuse.status === FuseStatus.SETTLED) throw new Error('risk increase forbidden in terminal state');
  if (nowSec > fuse.policy.expiryTs) throw new Error('risk increase forbidden after expiry');
}

export function initialFuse({ id, owner = 'demo-owner', agent = 'athena', executionAuthority = 'demo-worker', oracleAuthority = 'dflow', policy, policyHash }) {
  return {
    id,
    owner,
    agent,
    executionAuthority,
    oracleAuthority,
    policy,
    policyHash,
    status: FuseStatus.PROPOSED,
    desiredExposureUsd: 0,
    filledExposureUsd: 0,
    lastProbabilityBps: 0,
    lastMarkPrice: 0,
    lastSignal: null,
    oracleSequence: 0,
    executionNonce: 0,
    pendingExecutionNonce: 0,
    pendingTargetExposureUsd: 0,
    lastReceiptHash: ''.padStart(64, '0'),
    lastReasonCode: 'NOOP',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    killedAt: null,
    settledAt: null
  };
}

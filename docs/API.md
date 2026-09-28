# HTTP API

## GET /healthz
Returns deployment identity and health.

## GET /api/state
Returns mode, integrity metadata, Fuse state, reconciled venue position and receipt chain.

## GET /api/proof
Returns explorer-ready program/PDA/transaction references populated from deployment env.

## POST /api/arm
Arms the current Fuse.

## POST /api/tick
Fetches/validates one event observation and reconciles the target against actual venue exposure.

## POST /api/kill
Authorized emergency kill. Absorbing state; subsequent risk increases are forbidden.

## POST /api/verify
Runs the independent policy/receipt verifier.

## POST /api/replay
Runs deterministic policy replay over supplied probabilities.

## POST /api/probability, POST /api/chaos, POST /api/reset
Demo-only surfaces. Manual probability and chaos endpoints are disabled in live mode.

Live mutations require `Authorization: Bearer FUSE_ADMIN_TOKEN`.

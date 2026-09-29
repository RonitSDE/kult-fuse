# HTTP API

## Public

### GET /healthz
Returns deployment identity and health (network, market, program, adapters, build).

### GET /api/state
Returns integrity metadata, the live market, Fuse state (including its onchain transactions), the reconciled venue position and the receipt chain.

### GET /api/proof
Returns explorer-ready program / Fuse account / pinned transaction references.

### POST /api/verify
Runs the independent policy/receipt verifier. Read-only.

## Operator

Require `Authorization: Bearer FUSE_ADMIN_TOKEN`.

### POST /api/arm
Arms the current Fuse onchain.

### POST /api/tick
Polls the live market once and reconciles the target against actual venue exposure. The server worker does this continuously (`AUTO_WORKER`).

### POST /api/kill
Authorized emergency kill. Absorbing state; subsequent risk increases are forbidden.

### POST /api/settle
Settles the Fuse once venue exposure is zero.

### POST /api/fuse/new
Starts the next mandate after the current Fuse is killed or settled: creates a new onchain Fuse account committed to the live policy and market.

### POST /api/auth
Returns 200 when the operator token is valid.

# HTTP API

Public GET /healthz: build identity and health. GET /api/state: quote, Fuse state, actual venue position, receipts, worker decisions and unbound-authority status. Public GET /api/decisions returns the current mandate's bounded worker decision journal as JSON; it is not execution proof. GET /api/proof: links and verified replay only when current receipts pass onchain verification. POST /api/verify: read-only independent verification from Solana RPC.

Operator POST /api/auth, /api/arm, /api/tick, /api/kill, /api/settle, /api/fuse/new require Authorization: Bearer FUSE_ADMIN_TOKEN. Do not expose owner or trading keys to a browser. On a loss of the persistent DATA_DIR, the server refuses a new mandate if the venue still has exposure.

**Setup mode.** When the live runtime can't start (missing keys, IDL, market or an unreachable RPC), `/healthz` answers 200 with `status: "setup"`, `/api/state` returns `{ mode: "setup", market, quote, policy, policyHash, preview, setup: { checklist, error } }`, `/api/proof` returns empty proof, and every other route answers 503. The server retries going live every `SETUP_RETRY_SEC` seconds.


## Authenticated agent proposal precheck (v1.8)

`POST /api/agent/proposal` with `Authorization: Bearer FUSE_ADMIN_TOKEN` and JSON body:

```json
{ "fuseId": "<current runtime fuse id>", "policyHash": "<current policy SHA-256>", "targetUsd": 25, "proposedAtMs": 1790000000000 }
```

`proposedAtMs` must be within two minutes, and the market quote must pass the freshness/quality gates. The response is **`NOT_EXECUTED`** even when it says `ALLOW_AS_PROPOSAL_ONLY`; **it has no authority to place an order**. It is a policy preview for an external agent to use before a separately authorized, onchain-checked venue workflow. Do not log or publicly disclose the bearer token.

Public `GET /api/agent/check?targetUsd=25` runs the same curve, cap, expiry and signal-quality checks against the current mandate (or, in setup mode, the committed policy, with `preview: true`). It needs no token, is capped at 240 calls a minute across all visitors, and is always `NOT_EXECUTED`. The dashboard's "Be the agent" box uses it.

Public `POST /api/verify` is capped at one concurrent request and six calls/minute across all visitors; a rejected request receives HTTP 429.

## v1.10.0 read-only endpoints

- `GET /api/market/context` — DFlow's authoritative-for-Fuse policy probability and an **optional reference-only** Kalshi market/book snapshot. Uses fixed official host and selected DFlow market ticker. Missing Kalshi reads are nonfatal; no Kalshi auth or trade API. Do not treat the comparison as an execution oracle.
- `GET /api/journal` — current mandate decision/receipt projections and evidence-level counts. `WORKER_LOG_ONLY` is not a chain event and `CAPTURED_UNVERIFIED` is not a verified fill; the frontend uses `/api/proof` to mark independently verified receipt hashes.

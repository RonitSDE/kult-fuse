# Production deployment notes

## Recommended deployment shape

For the hackathon, one process is acceptable. For production, split:

1. **Observer/API** — public/read-mostly UI and verifier data.
2. **Oracle worker** — reads the prediction market (Polymarket / DFlow), validates spread/freshness, submits observations.
3. **Execution worker** — computes target, reads actual perp position, sends reduce/increase actions, reconciles.
4. **Anchor program** — mandate/lifecycle/replay/risk-cap enforcement and receipt head.
5. **Persistent database/indexer** — receipts and operational telemetry. Onchain state remains the authorization anchor.

Use a queue or durable job ledger between target creation and venue execution. Never infer that a transaction failed only because a timeout occurred.

## Secrets

Reference `.env` is for development only. Production keys should live in cloud KMS/HSM or a dedicated signing service. Separate oracle/execution/owner authorities and enforce network egress allowlists.

## Monitoring alarms

Page immediately on:

- `KILLED` while actual venue exposure != 0;
- target/actual mismatch beyond tolerance for > N seconds;
- stale prediction-market signal;
- receipt anchoring failure;
- transaction ambiguity/retry exhaustion;
- worker restart loop;
- RPC health degradation;
- unexpected authority change;
- target cap rejection.

## RPC semantics

Use confirmed/processed updates for responsiveness only when your reconciliation logic understands reorg/skip risk. For financial finality/accounting, wait for appropriate confirmation/finality. Always reconcile actual state after reconnect.

## Database

The file store is intentionally zero-dependency for local testing. Replace it in production with Postgres or equivalent. Receipt rows should be append-only and indexed by `(fuse_id, sequence)` with a uniqueness constraint.

## User authorization

The reference live server uses an admin bearer token to protect mutation endpoints. A consumer deployment should use wallet signatures/onchain owner instructions instead. Do not expose owner private keys through the web service.

# KULT Fuse v1.2 — Final Local Validation

Validated: 2026-09-26T20:28:07Z

## Release status

- Node source syntax checks: **PASS**
- Automated test suite: **14/14 PASS**
- Deterministic release simulation: **PASS**
- Release check: **PASS**
- Flash Trade adapter: stable `flash-sdk@15.17.2` path, custody-account derivation uses documented `PoolConfig.custodies`
- Legacy Drift venue references in source/docs: **NONE**
- Runtime state / secrets included in archive: **NONE**

## Proven locally

- piecewise P → E(P) policy
- hard target-notional cap
- hysteresis / debounce
- stale-oracle no-risk-increase behavior
- oracle replay rejection
- execution nonce protection
- venue-position reconciliation / double-execution recovery
- absorbing kill
- tamper-evident receipt chain
- independent verifier including malicious-target rejection
- Judge path: 61% → $300; 72% → $420; simulated 28% → KILLED / $0

## External deployment gates

The archive intentionally does **not** claim external proofs that cannot be produced in this environment. Before submission the deployer must complete:

1. Run `anchor build && anchor test` (the included local integration smoke) and deploy the Fuse program to Solana devnet.
2. Create/arm a real Fuse PDA and capture program transaction signatures.
3. Run authenticated DFlow live-data smoke.
4. Run Flash Trade devnet $20 → $30 → $0 smoke and capture open/resize/close signatures.
5. Deploy the public web/API service and verify `/healthz` and `/api/proof` externally.
6. Populate explorer proof fields, tag the exact submission commit, and record the video from that build.

See `docs/DEPLOY_FINAL.md` for the one-pass runbook.

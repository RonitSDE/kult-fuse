# KULT Fuse v1.2 — Final Local Validation

Validated: 2026-09-29

## Release status

- Node source syntax checks: **PASS**
- Automated test suite: **22/22 PASS**
- Release check: **PASS**
- Fuse program deployed to Solana devnet: `C43aRCCQyAw28vCZ4GRTr8yPt7dTc8CbiY26VdZRRcEv`
- Live server against the devnet program (local market/venue stand-ins): arm → $300 → $420 → onchain kill → $0 → verifier PASS → new mandate
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
- onchain commitments only when the target changes; failed risk increases never reach the venue

## External deployment gates

The archive intentionally does **not** claim external proofs that cannot be produced in this environment. Before submission the deployer must complete:

1. Choose an active, liquid Polymarket market and run `npm run smoke:polymarket` from the host (some ISPs block Polymarket).
2. Fund the Flash key with Flash devnet USDC.
3. Arm the live Fuse from the operator UI.
4. Run Flash Trade devnet $20 → $30 → $0 smoke and capture open/resize/close signatures.
5. Deploy the public web/API service and verify `/healthz` and `/api/proof` externally.
6. Populate explorer proof fields, tag the exact submission commit, and record the video from that build.

See `docs/DEPLOY_FINAL.md` for the one-pass runbook.

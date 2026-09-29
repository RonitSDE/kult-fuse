# KULT Fuse v1.2 — Build Report

## Included

- Anchor Fuse program source with onchain curve recomputation, hard cap, expiry, replay protection and absorbing kill. Includes an Anchor local integration smoke (`init → arm → 61%/$300 → 28%/KILLED → $0`, reopen rejected).
- Polymarket (default) and DFlow event adapters with midpoint/spread/freshness validation.
- Flash Trade perp adapter with venue reconciliation before and after execution.
- Backend HTTP API; every state-changing action requires the operator token.
- Live dashboard with operator controls, verifier and Chain Proof panel; receipts link to their onchain transactions.
- Tamper-evident receipt chain + independent verifier.
- Docker deployment files, preflight/release scripts and final deployment runbook.

## Locally validated in this package

- `npm test`: deterministic policy, hysteresis/debounce, replay rejection, stale signal safety, absorbing kill, malicious target detection, receipt verification and double-execution recovery.
- Backend/API/static frontend runtime.
- Syntax checks for final Node sources.

## External validation required by deployer

1. Polymarket live market smoke from the production host.
2. Flash Trade devnet open → resize → close smoke with a USDC-funded key.
3. Public hosting.

These are deployment gates, not hidden claims.

# KULT Fuse v1.2 — Build Report

## Included

- Anchor Fuse program source with onchain curve recomputation, hard cap, expiry, replay protection and absorbing kill. Includes an Anchor local integration smoke (`init → arm → 61%/$300 → 28%/KILLED → $0`, reopen rejected).
- DFlow event adapter with midpoint/spread/freshness validation.
- Flash Trade perp adapter with venue reconciliation before and after execution.
- Paper adapter for deterministic Judge Demo.
- Backend HTTP API + authorization in live mode.
- Interactive judge frontend with Judge Demo, Chaos Test, verifier, replay and Chain Proof panel.
- Tamper-evident receipt chain + independent verifier.
- Docker deployment files, preflight/release scripts and final deployment runbook.

## Locally validated in this package

- `npm test`: deterministic policy, hysteresis/debounce, replay rejection, stale signal safety, absorbing kill, malicious target detection, receipt verification and double-execution recovery.
- Judge flow: 61% → $300; 72% → $420; 28% simulated shock → KILLED/$0; verifier PASS.
- Backend/API/static frontend runtime.
- Syntax checks for final Node sources.

## External validation required by deployer

This environment cannot perform the following because it does not contain Solana/Anchor toolchains, venue credentials or funded devnet accounts:

1. `anchor build` / `anchor test` / devnet deploy.
2. DFlow authenticated live market smoke.
3. Flash Trade devnet open → resize → close smoke.
4. Public hosting and explorer proof-link population.

These are deployment gates, not hidden claims. The frontend says `LOCAL VERIFIED` until onchain metadata is configured.

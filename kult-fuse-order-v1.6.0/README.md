# KULT Fuse v1.6 · event-conditioned perp mandate

A user commits a probability-to-exposure curve, a maximum size, an expiry and a kill threshold on Solana. A Polymarket YES quote proposes a SOL-PERP long target. Fuse validates worker-submitted targets; a Drift adapter attempts a bounded immediate-or-cancel order, then reads the actual position. Receipts are published only for position changes with a venue signature and are anchored by Fuse.

**Trust boundary:** the Drift wallet is currently controlled by the worker. Fuse does not custody it or prevent trades sent around Fuse. The quote is supplied by a trusted oracle worker. A kill blocks new Fuse targets; the venue close is a separate transaction that can fail or slip. Do not describe this release as trustless or bound authority.

## Release status

This is a source handoff for the next deployment, not proof of a completed execution. The prior v1.2 devnet Fuse create/arm/target/kill links are historical and do not prove the current program or Drift adapter. This package contains no real Drift open/resize/close signatures, no current hosted URL, no live loss-stop trace and no video of this version. Until those are supplied, the independent verifier must display **No execution to verify** or **Unverified**. The submission manifest is intentionally blank and the submission gate fails.

The v1.3 program adds an observation timestamp to its account. The developer must compile and deploy/upgrade it, generate a matching IDL and create new mandates; do not reuse v1.2 accounts.

## Product flow

1. Select a liquid, open Polymarket event with a direct SOL consequence. Document why a YES outcome implies the chosen SOL-PERP long, and when that relationship stops being valid.
2. Commit the event ID, outcome, curve, cap, expiry and kill threshold in a Fuse account. This source default is a tiny 10 → 15 → 25 → 30 USD curve and a 30 USD cap. It is a test size, not a return claim.
3. The worker rejects stale, wide or thin books for risk increases. Fuse rejects a stale observation for an increasing target, mismatched curve targets, over-cap targets, expired increases and new targets after kill.
4. Drift places a price-bounded immediate-or-cancel order; the engine compares the venue's actual before and after base position. A confirmed transaction with no fill produces no execution receipt.
5. The verifier checks the local policy hash against the onchain Fuse commitment, the receipt chain against the onchain head, each matching Fuse FillRecorded event, and each matching Drift OrderActionRecord against the receipt's base delta. Missing evidence fails closed.

The included replay button is expressly **simulation**. A verified replay appears only for a live independently verified receipt history.

## Setup

Requires Node 22.14+, npm, Solana CLI, Rust and Anchor 0.31 for the program.

~~~bash
npm ci
npm test
cp .env.example .env
cd contracts/fuse-anchor
anchor build
anchor test
# Deploy only to the cluster chosen for the test; save the program upgrade authority.
anchor deploy --provider.cluster devnet
cd ../..
mkdir -p deploy/idl
cp contracts/fuse-anchor/target/idl/kult_fuse.json deploy/idl/kult_fuse.json
npm run preflight
npm run smoke:polymarket
npm start
~~~

The generated IDL in deploy/idl must be committed with the release source. The package has no generated IDL or binary because no Anchor compiler is available in this environment. Do not start the server before building the IDL and deploying the matching program.

Set POLYMARKET_MARKET, SOLANA_RPC_URL, FUSE_PROGRAM_ID, three distinct Fuse signer keys, DRIFT_RPC_URL, DRIFT_PRIVATE_KEY_JSON and a long FUSE_ADMIN_TOKEN in .env. Pick DRIFT_ENV and SOLANA_CLUSTER on the **same cluster** for the public demo. Keep AUTO_WORKER=0 until a funded, isolated venue account has passed manual smoke and close. The separate scripted proof runner is labelled scripted signal; it does not prove a live market signal.

Run the deployment and evidence checklist in [docs/DEPLOY_FINAL.md](docs/DEPLOY_FINAL.md). The read-only verifier is `npm run verify -- --url https://YOUR_HOST`. It needs public RPC access and the build's matching IDL. After filling the manifest with genuine links, regenerate the checksum list with `npm run manifest:source` and check it with `sha256sum -c SOURCE_MANIFEST.sha256`. Then run `npm run submission:check -- --url https://YOUR_HOST`. That gate cross-checks the host, quote, mandate, signatures, receipts and the independent RPC verifier; it cannot create missing proof. API surface: [docs/API.md](docs/API.md).

## What remains before submission

| Gate | Requirement |
| --- | --- |
| Venue | On the selected cluster, real tiny Drift open → resize → close; three signatures, decoded fills and residual near zero |
| Safety | Demonstrate over-cap and post-kill Fuse refusal; demonstrate actual venue close after kill, and disclose unbound key |
| Stop | Keep lossStopUsd=0 on the live judge policy unless a real venue P&L trigger and close are shown; a stop is a trigger, never a guaranteed maximum loss |
| Presentation | Public URL, /healthz 200, live event quote, accurate proof links, exact build SHA, demo video from that URL |
| Authority | Program-signed venue delegation and denial at the venue boundary is **not implemented**; see [docs/BOUND_AUTHORITY.md](docs/BOUND_AUTHORITY.md) |

Tests here cover deterministic policy, receipts, decoded event matching helpers and recovery paths with mocks. They do **not** substitute for Anchor compilation, current Drift SDK/runtime validation, RPC execution or an audit.

## Repository

- contracts/fuse-anchor: Solana policy program
- src/core, src/worker: curve, state machine, receipt engine, verifier
- src/adapters/event: Polymarket and DFlow readers
- src/adapters/perp: Drift and legacy Flash adapters
- src/http and web: API, operator dashboard and simulation
- scripts and tests: release gate, proof runner and deterministic checks

Historical v1.2 proof is retained at [docs/devnet-proof.json](docs/devnet-proof.json) for context only.

## Frontend experience

The dashboard presents the current decision and actual venue exposure first. It distinguishes a usable live quote from stale/unavailable data, shows a persistent backend outage banner, and warns if a killed mandate retains venue exposure. Operator access uses a password dialog; proof badges remain neutral until matching venue fills and Fuse anchors verify. The animated simulation never borrows real explorer links. Mobile and reduced-motion layouts are included.

## UI hotfix v1.4.1

The preview exposed a missing global `.hidden` CSS rule, which made receipt-dependent controls appear with no receipts. This release hides those controls and shortens the opening hero so the current decision appears earlier on common desktop viewports. The private simulation preview has an explicit mock-data banner and is not venue execution proof.

## Decision journal in v1.5

Each worker arm, tick, and kill now records a bounded operational decision under the current mandate. The public `/api/state` includes the latest journal and `/api/decisions` exports up to 60 entries. Stale/wide/thin quotes, confirmation holds, failed chain commitments, venue no-fills, residual close pending, and observed fills are explicit. Repeated identical holds collapse with a count. These records are saved locally and are **not cryptographic proof**, and they do not bind the venue key. Only the independent receipt verifier can mark fills verified. The primary UI shows the latest six decisions, with worker-log labels and separate venue links.

## Release correctness in v1.6

Expiry now commits a kill and attempts to flatten without waiting on a quote API. A killed, already-flat mandate creates no phantom venue order or receipt. Runtime mutations are serialized, so an operator kill cannot race a worker tick through the same nonce or venue position. The close proof also recognizes expiry closes. The release test runner discovers all test files; the submission gate keeps missing public evidence visible rather than inventing it. These are local code checks, not live trading proof.

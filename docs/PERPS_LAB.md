# KULT Fuse v1.10.0 · guardrails for AI trading agents

**The agent proposes. The mandate decides. Every fill is checked against Solana.**

(This build's venue key is still held by the worker; see [What this build does not do](#what-this-build-does-not-do).)

An owner commits a mandate to a Solana program: a curve from Kalshi probability to SOL-PERP exposure, a hard cap, a kill line and an expiry. An agent reads the Kalshi market through DFlow and proposes a target. The Fuse program refuses any target off the curve, over the cap, after expiry or after a kill. Only then does the worker trade on Velocity. Every fill becomes a receipt anchored on-chain, and an independent verifier matches it to Velocity's own fill event.

```
Kalshi market ──DFlow──► oracle worker ──observation──► Fuse program (curve · cap · kill · expiry)
  (SPL outcome mints)       grade: fresh, tight, deep          │ authorizes target or refuses
                                                                ▼
                         execution worker ──bounded IOC──► Velocity SOL-PERP
                                │                                │ fill event
                                └──── receipt hash ──► Fuse ◄────┘ verifier matches both
```

## What changed in v1.10.0 — Kalshi context + agent accountability

- **Two viewpoints, one trading source.** DFlow's on-Solana YES book remains the **only** signal used by the risk engine. A new public Kalshi REST observer reads `/markets/{ticker}` and `/markets/{ticker}/orderbook` for a separate, potentially delayed market reference. It requires **no Kalshi key**, never places an order, and does not change a Fuse target.
- **Refusal and execution history.** The new Decision Journal shows only events associated with the current mandate. Every entry has an evidence level: `WORKER_LOG_ONLY`, `CAPTURED_UNVERIFIED`, or `INDEPENDENTLY_VERIFIED` (only when a receipt also appears in the RPC verifier's verified run). An attempted kill is never counted as a confirmed close.
- **Accountability metrics:** worker decisions, risk holds/refusals, captured fills, and verified fills. None of these are profitability or trading performance claims.
- **Kalshi safety:** fixed official hosts, validated ticker from DFlow (not user input), bounded fetch/response size, 30-second cache, and graceful fallback. Market mismatch/divergence is a **warning**, never an alternative oracle.
- **No new financial authority:** no direct Kalshi trading, Kalshi Perps, FIX, MCP account tools, additional markets, delegated Velocity trading key, or real-money mainnet readiness claims.
- **Testnet handoff:** See [docs/v1.10_RELEASE.md](docs/v1.10_RELEASE.md) and [docs/DEVNET_DEPLOY_SHORT.md](docs/DEVNET_DEPLOY_SHORT.md).

## What changed in v1.9.1 — judge-facing experience hardening

- **Simple first-time journey:** the top of the dashboard now explains the user problem in plain English and offers a four-step, no-wallet walkthrough: allowed proposal → over-cap refusal → kill → post-kill refusal.
- **No simulated/live ambiguity:** the walkthrough has a persistent `SIMULATION · NOT EXECUTED` banner, shows no invented live venue exposure or P&L, and never changes the underlying venue state. The synthetic UI preview likewise announces itself in the header, curve and decision panel.
- **Honest venue-authority disclosure above the fold:** the worker retains Velocity signing authority and can bypass Fuse; a policy kill does not guarantee the venue position has closed.
- **Mobile-first chart alternative:** mobile displays legible probability thresholds and their permitted exposures instead of shrinking a dense SVG chart.
- **Independent evidence stays separate:** receipt replay and the real proof/verification panels remain distinct from illustrative demo steps. A replay never sends a transaction.
- **Browser-module serving fixed:** Node HTTP and synthetic preview servers recognize `.mjs` as JavaScript (required by the read-only view helper).
- **Quality gates:** 92 JavaScript tests locally, including 10 presentation-boundary tests; browser fixture checked at 1440px and 390px with no script errors or horizontal overflow. No live Anchor/Velocity integration is claimed.

## What changed in v1.9

- **Fixed: a quiet market could never trade.** v1.8 aged a DFlow quote from the last time the book *changed*, so any calm Kalshi book went "stale" after 20 seconds, and it threw `oracle replay rejected` on every poll of an unchanged book, filling the worker log with errors. Now an unchanged book is held as the same observation (no error, nothing on-chain), the quote's age is when it was fetched, and the feed must have visibly moved within `DFLOW_MAX_BOOK_IDLE_SEC` (900 s) to count as live. A frozen or rewound feed still fails closed.
- **Fixed: missing venue P&L blocked kills.** v1.8 skipped the whole tick when P&L was unavailable under a loss stop, so a probability kill couldn't fire. Now missing P&L blocks increases only.
- **Be the agent.** A public box under the curve: type an exposure, ask the mandate, and see it allowed or refused in plain words, drawn on the curve. Same curve, cap and signal rules as the worker; it never trades. Replaces the operator-only precheck panel that judges would never have seen.
- `npm run smoke:dflow` now watches the book until it moves, so it proves the feed is live.
- 82 tests, including five that fail on v1.8 and pass here.

## v1.8 (source hardening)

- **DFlow freshness is now source-derived:** the initial snapshot and unchanged book sequences cannot count as fresh confirmation. Metadata-only fallbacks are displayed but cannot authorize a risk increase. No fabricated remote timestamps.
- **Operational collateral/leverage check:** before any Velocity exposure increase (including recovery), the worker checks the latest venue collateral against the mandate maximum leverage. This is not a cryptographic venue-level limit.
- **Agent proposal precheck:** `npm run agent:demo` illustrates bounded agent intents, one allowed and one refused. The authenticated `/api/agent/proposal` endpoint is NOT_EXECUTED; it does not sign or place a trade.
- **Risk fail-closed:** no increase when venue P&L is unavailable and the owner configured a loss stop; future-timestamped quotes are refused.
- **Public verification is throttled** without trusting client-supplied IP headers. Node preflight now matches Node >=24 requirement.
- **No real proof supplied:** the Venue delegated authority is still unbound and the worker retains signing power. See `docs/BOUND_AUTHORITY.md` and `docs/v1.8_RELEASE.md`.

## Earlier v1.7 foundations

- **Venue: Drift → Velocity.** Drift's program was replaced by Velocity (Drift v2's successor) and Flash Trade shut down, so the v1.6 build couldn't fill an order anywhere. The adapter is ported to `@velocity-exchange/sdk` 0.27.0: IOC via Velocity's order bit flag, the moved step and minimum sizes, dUSDT collateral on devnet, and fill evidence decoded with the SDK's own parser.
- **Signal: Polymarket → Kalshi via DFlow,** on Solana. Quotes come from the YES mint's orderbook with real top-of-book depth. `npm run markets` finds markets; no API key needed on the dev host.
- **Never a dead page.** Without full config the server starts in setup mode. It shows the live signal, the committed curve, what the mandate would permit right now, and a checklist of exactly what's missing. Nothing executes until it's live, and it retries going live on its own.
- **New dashboard.** One instrument in the middle: the committed curve with the live probability needle, permitted vs. actual exposure, the cap and the kill zone. A labelled simulation walks open → resize → over-cap refusal → kill → refused reopen. Receipts, on-chain proof and the worker's reasoning sit underneath. Works on a phone.
- **Installation baseline.** A lockfile is included; the full Node 24 `npm ci` gate still must be demonstrated by a clean CI runner for this v1.8 release. The dead Drift and Flash SDKs are removed.
- `npm run venue:setup` funds and opens the Velocity account in one command.

## Run it

Node 24 (the Velocity SDK's Pyth Lazer dependency asks for it), npm, and for the program: Solana CLI, Rust, Anchor 0.31.

```bash
npm ci
npm test                     # includes Kalshi observer and journal tests
cp .env.example .env
npm start                    # http://localhost:8787 — setup mode until configured
```

Then work through [docs/DEPLOY_FINAL.md](docs/DEPLOY_FINAL.md): deploy the program, pick a market, fund the venue, go live, record the proof.

| Command | What it does |
|---|---|
| `npm run markets` | Active Kalshi markets on DFlow with their YES mints (`--series`, `--search`) |
| `npm run smoke:dflow` | Watches the chosen market until the book moves, then grades the quote |
| `npm run venue:setup -- --fund 25` | Devnet: mints dUSDT, creates the Velocity account, deposits |
| `npm run preflight` | Checks every env value the live runtime needs |
| `npm run agent:demo` | Offline agent proposal allow/refuse (NO TRADE, NOT_EXECUTED) |
| `npm run proof:venue` | Scripted-signal proof run with real Fuse transactions and real Velocity fills |
| `npm run verify -- --url https://HOST` | Independent verifier against Solana RPC, no server keys |
| `npm run submission:check -- --url https://HOST` | Release gate: refuses until every proof link is real |
| `node scripts/ui-preview.mjs` | Dev only: the dashboard on synthetic data, port 8098. Never deployed |

## What the program enforces

On every target the worker submits: it must sit on the committed curve, under the cap, before expiry, with a fresh observation for any increase, and never after a kill (the kill is absorbing). Risk reductions always pass, even during a quote outage. Nonces only go up.

The worker adds its own gates: stale, wide or thin quotes block increases; band changes need repeated confirmation; positions are read before and after every order; IOC means nothing rests on the book after a kill; a confirmed transaction with no fill writes no receipt.

## What this build does not do

The Velocity key is held by the worker, so the worker could trade around Fuse. A Fuse kill is not a venue close; the close is a separate transaction that can fail or slip. The signal observation is submitted by the worker. Binding the venue key to a Fuse PDA, the same delegate pattern Velocity's Vaults program uses, is the next milestone: [docs/BOUND_AUTHORITY.md](docs/BOUND_AUTHORITY.md). The dashboard states this on screen.

## Release status

This is source, not proof. It has no compiled program, no generated IDL, no independently validated live Velocity fill, no public URL and no video yet. The tests cover policy, receipts, decoders, setup mode and recovery paths with mocks; they don't replace an Anchor build, a live devnet fill or an audit. Until the live run exists, the verifier shows **No execution to verify** and the submission gate fails, by design. `docs/devnet-proof.json` is the historical v1.2 run, kept for context only.

## Repository

- `contracts/fuse-anchor` — the Solana policy program
- `src/core`, `src/worker` — curve, state machine, receipts, verifier
- `src/adapters/event` — DFlow (Kalshi), read-only Kalshi reference and legacy Polymarket reader
- `src/adapters/perp` — Velocity adapter, fill decoder, generic driver
- `src/http` — API, setup mode, static dashboard in `web/`
- `scripts`, `tests` — tooling, proof runner, release gate

API: [docs/API.md](docs/API.md) · Threat model: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) · Integrations: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)

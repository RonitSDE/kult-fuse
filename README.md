# KULT Fuse

**Turn probability into position — within a mandate Solana enforces.**

KULT Fuse is a Solana execution mandate. A live prediction-market probability drives a perpetual-futures position, but only inside a policy the user commits onchain before any capital moves: a fixed probability → exposure curve, a hard notional cap, an expiry and an absorbing kill switch. The Fuse program checks every target the execution agent submits against that committed curve, and every fill produces a tamper-evident receipt anchored onchain.

> **The agent proposes. The user authorizes. The policy executes. Solana verifies.**

## Links

> Fill these in before submitting.

| | |
|---|---|
| Live app | [https://kult-flux.rj838486.workers.dev](https://kult-flux.rj838486.workers.dev) |
| Backend health | [https://kult-fuse-qep5.onrender.com/healthz](https://kult-fuse-qep5.onrender.com/healthz) |
| Demo video | `TODO: video link` |
| Fuse program (Solana devnet) | [`C43aRCCQyAw28vCZ4GRTr8yPt7dTc8CbiY26VdZRRcEv`](https://solscan.io/account/C43aRCCQyAw28vCZ4GRTr8yPt7dTc8CbiY26VdZRRcEv?cluster=devnet) |
| Proof-run Fuse account | [`Cxcfb6SnTTGJCffVX5TqncVgJGV69n9aKv8FATJr5Mhf`](https://solscan.io/account/Cxcfb6SnTTGJCffVX5TqncVgJGV69n9aKv8FATJr5Mhf?cluster=devnet) |

### Devnet proof links

These four Fuse transactions confirmed on devnet for a $15 → $25 SOL/USDC attempt:

| Step | Transaction |
|---|---|
| Create | [`57PkkfhowF8eZygC92VKk2ixkSkfRoNBN9wqjD6Xn9eLWvYjoruS16aXKBeEEHqf6Hi8hU4z2gzPLQnkgtdbqSAQ`](https://solscan.io/tx/57PkkfhowF8eZygC92VKk2ixkSkfRoNBN9wqjD6Xn9eLWvYjoruS16aXKBeEEHqf6Hi8hU4z2gzPLQnkgtdbqSAQ?cluster=devnet) |
| Arm | [`5cahRvvKGtDx62TgBT35uPwDthxRtsxX4BoBrFxVdPEMua9U7JszLvDd3qB1yz3gHR5Pm24m6BXLXuZxDsBiXN1U`](https://solscan.io/tx/5cahRvvKGtDx62TgBT35uPwDthxRtsxX4BoBrFxVdPEMua9U7JszLvDd3qB1yz3gHR5Pm24m6BXLXuZxDsBiXN1U?cluster=devnet) |
| Target | [`vzvQAWh2BLRgaTLCFFTGNrVU1VG96b1Jiob2Eh8y2U8MkdEs8smZxir8PhuktVg3LtLsmM8o7kecLYNFrh3SWjk`](https://solscan.io/tx/vzvQAWh2BLRgaTLCFFTGNrVU1VG96b1Jiob2Eh8y2U8MkdEs8smZxir8PhuktVg3LtLsmM8o7kecLYNFrh3SWjk?cluster=devnet) |
| Kill | [`2V7uzwpAoc866BJNQm3qs7waMKKsr1BZWGg2wN4XGTByS4Z8EjREgo96Hb9QhKzjfZXwkxDMgeLzeXTnehJ8RB2Q`](https://solscan.io/tx/2V7uzwpAoc866BJNQm3qs7waMKKsr1BZWGg2wN4XGTByS4Z8EjREgo96Hb9QhKzjfZXwkxDMgeLzeXTnehJ8RB2Q?cluster=devnet) |

Flash open, resize, and close did not land, so there are no venue signatures and the app does not offer a verified replay. The live devnet pool rejects the old `open_position` instruction. The replacement `open_position_er` was simulated against the only initialized SOL market (`SOL/JitoSOL` long) and returned `InstructionNotAllowed`: that market and its pool are not delegated to the rollup, and only the Flash admin can delegate them. The same Fuse links are in [`docs/devnet-proof.json`](docs/devnet-proof.json) and the dashboard chain-proof panel.

## Submission status

What is shipped and tested, and what is still outstanding. Nothing below is claimed beyond what the links show.

| Requirement | Status |
|---|---|
| **Verified execution** (open → resize → close with receipts) | Code complete and tested. Each receipt stores the venue tx signature, Fuse state, timestamp, position size, venue P&L and residual. `npm run verify -- --url <app>` fetches the receipts from the app and checks each venue tx and its `record_fill` anchor against a public Solana RPC, plus the onchain receipt head. Zero fills shows **No execution to verify**. A failed anchor or failed venue tx shows **Unverified**. **Outstanding: no real fill has landed yet.** The [real-venue proof run](#real-venue-proof-run) is built and dry-run tested against Drift mainnet; it needs a funded wallet. |
| **Loss stop** | Code complete and tested with a controlled losing position (`tests/execution.test.mjs`). Reads Flash `pnlWithFeeUsd` (fees included) first on every tick, before the quote is read, so a stale quote or a Polymarket outage cannot delay it. At the trigger it kills the Fuse (no further increases), closes, and stores the trigger P&L, close receipt, close tx and residual, shown on the dashboard. **$50 is a trigger, not a maximum loss:** the close fills at market and can slip. **Outstanding: not yet run against a real position;** mandate B of the proof run does this. |
| **Bound authority** | **Not bound.** Flash Trade has no delegated trading key scoped to a size cap or to Fuse state. The worker enforces Fuse limits and the program records them, but the venue does not check them; a compromised worker key could open over the cap or after a kill. Closing is never blocked. This limitation is shown on the dashboard. |
| **Clear signal** | Dashboard shows bid, ask, spread, quote age (from the CLOB book timestamp) and top-of-book depth, and a sentence saying why the quote does or does not change permitted exposure. Stale, wide or thin (optional `minTopDepthUsd`) quotes give **no increase**. The default market is a BTC prediction. Open SOL markets on Polymarket are short-dated (days) and most currently fail the spread gate; set `POLYMARKET_MARKET` to a SOL slug when a liquid one fits the mandate window. |
| **Submission proof** | **Outstanding:** demo video, a deploy of the exact tested commit, and explorer links for real fills, the loss-stop test and kill/close. Fill in the Links table once those exist. |

## Real-venue proof run

Flash Trade devnet rejects opens, and on 2026-10-14 Drift devnet rejected every deposit (`SpotMarketNotFound`), so no perp venue on devnet can fill today. The proof run therefore keeps the Fuse program on devnet and places the fills on **Drift mainnet** with a small real position ($15 → $25, cap $30, from [`policy.proof.json`](policy.proof.json)). Receipts record the venue's cluster, and both verifiers check each venue signature on that cluster.

```bash
# .env: DRIFT_ENV=mainnet-beta, DRIFT_RPC_URL=<mainnet RPC>, DRIFT_PRIVATE_KEY_JSON=<dedicated key>
# Fund that key with ≥ 0.02 SOL and ≥ $12 USDC on mainnet.
npm run proof:venue -- --dry-run                 # checks wallets, collateral and market; sends nothing
npm run proof:venue -- --confirm-mainnet         # runs both mandates, writes docs/venue-proof.json
npm run verify -- --file docs/venue-proof.json --mandate 0   # independent re-check (1 = loss-stop mandate)
```

- **Mandate A:** open $15 → resize $25 → a $100 target refused onchain (`RiskCapExceeded`) → probability kill → close → a $25 target after the kill refused onchain (`KilledCanOnlyClose`) → settle.
- **Mandate B:** open $15, then wait for Drift P&L (fees included) to reach `PROOF_LOSS_STOP_USD` (default −$0.25) → close. If it does not trigger within `PROOF_LOSS_WAIT_MIN` (default 45 minutes), the run closes with an emergency kill and records it as such, not as a loss stop.
- **What is real and what is scripted:** the probability path is scripted (`source: scripted-proof`) so the run walks the curve on demand. Fuse transactions, venue orders, positions, P&L and receipts are real.
- **Limits:** the refusals happen in the Fuse program, not at Drift, which cannot scope a key to Fuse limits. The −$0.25 stop is far below the production −$50 so that a normal price move can trigger it. The program stores `loss_stop_usd` as whole dollars, so this run records 0 onchain; the policy hash still commits the exact value.
- **Expected cost:** about $0.10–0.50 in fees, the loss-stop loss, and price movement on the ~$25 position.

## The problem

Prediction markets price *what may happen*. Perpetual markets trade *the consequence*. Connecting the two today means handing an agent or bot open-ended trading authority and trusting it to follow the strategy. Nothing stops it from sizing up, ignoring a stop, or reopening after it should have stopped.

## How KULT Fuse works

```text
Polymarket order book ──▶ probability P ──▶ committed curve E(P) ──▶ Flash Trade SOL-perp
   (live bid/ask)          (fresh, tight)      (checked onchain)        (reconciled position)
                                                     │
                                                     ▼
                                     Fuse program on Solana devnet
                              cap · expiry · kill · nonces · receipt head
```

1. **Commit.** The user's policy (curve, cap, kill threshold, expiry) is hashed and written to a Fuse account on Solana before trading starts.
2. **Observe.** The oracle worker reads the market's live order book and derives a probability from the best bid/ask. Stale or wide-spread quotes can never increase risk.
3. **Authorize.** When the probability crosses a band, the execution agent submits a new target. The program recomputes the curve onchain and rejects any target that doesn't match or exceeds the cap.
4. **Execute.** The venue adapter moves the Flash Trade position to the authorized target and reconciles against the venue's actual position.
5. **Prove.** Each fill creates a hash-chained receipt; its hash and the fill are recorded onchain. Anyone can run the independent verifier against the receipt chain.

If the probability falls below the kill threshold, the program moves the Fuse to **KILLED**. That state is absorbing: the only permitted action is closing to zero.

### The committed curve (v1)

| Event probability | Target SOL-perp notional |
|---:|---:|
| `< 35%` | `$0` + absorbing KILL |
| `35–49.99%` | `$100` |
| `50–59.99%` | `$200` |
| `60–69.99%` | `$300` |
| `70–79.99%` | `$420` |
| `≥ 80%` | `$500` hard cap |

Band changes require two consistent observations plus ±1% hysteresis; kills skip the debounce. The curve lives in [`policy.example.json`](policy.example.json).

## What is enforced where

**Enforced by the Solana program**

- policy commitment and curve parameters
- `P → E(P)` target validation (recomputed onchain)
- hard notional cap
- lifecycle state machine and absorbing KILL
- expiry: no risk increases after the market ends
- oracle-sequence and execution-nonce replay protection
- separate owner, oracle and execution authorities

**Trusted / attested in v1**

- the prediction-market quote itself
- Flash Trade fills and offchain transaction construction
- Flash unrealized P&L. The worker reads Flash `pnlWithFeeUsd` (net of fees). If that P&L reaches −$50, the worker submits an authorized kill and a close. The Fuse program stores `loss_stop_usd` and checks the submitted target; it does not read the Flash wallet or compute that P&L. −$50 is the trigger; the realized loss can be larger if the close slips.

**Trust boundary — venue authority is not bound.** Fuse checks the targets submitted to it. It does not control the Flash wallet, and Flash offers no way to scope the trading key to a size cap or to the Fuse state. An over-cap open or an open after a kill is refused by the worker, not by the venue. An onchain kill blocks new Fuse exposure; the worker sends the separate Flash close, and closing is never blocked.

The execution agent cannot get a target larger than the committed curve through the program. See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## Built with

- **Solana + Anchor 0.31** — the Fuse program ([`contracts/fuse-anchor`](contracts/fuse-anchor))
- **Polymarket** — live prediction-market data (public Gamma + CLOB APIs); DFlow / Kalshi also supported
- **Flash Trade** — SOL-perp execution on devnet via `flash-sdk`
- **Node.js** — worker, API and dashboard (no framework)

## Repository

```text
contracts/fuse-anchor/     Anchor program (Rust)
src/core/                  deterministic policy, risk, receipts, verifier
src/worker/                observe → authorize → execute → prove engine
src/adapters/event/        Polymarket + DFlow prediction sources
src/adapters/perp/         Flash Trade + generic venue driver
src/adapters/store/        file store + Anchor client
src/http/                  API + static web server
web/                       live dashboard + operator controls
scripts/                   smoke tests, preflight, release check
tests/                     unit/integration tests (+ fixtures)
docs/                      deploy runbook, API, threat model, integrations
```

## Run it

Requires Node.js 22.9+, and for the program: Rust, Solana CLI and Anchor 0.31.

```bash
npm install
npm test                    # 31 deterministic tests

cp .env.example .env        # fill keys and operator token; market slug is in code
npm run preflight           # checks every required setting
npm run smoke:polymarket    # live quote for the chosen market
npm run smoke:flash         # read-only Flash devnet connection
npm start                   # http://localhost:8787
```

Verify a deployment independently (no server keys; uses `VERIFY_RPC_URL`, default public devnet):

```bash
npm run verify -- --url https://kult-flux.rj838486.workers.dev
```

On first boot the server creates its Fuse account onchain, bound to the policy and market. Open the app, click **OPERATOR LOGIN**, enter `FUSE_ADMIN_TOKEN`, then **ARM FUSE**; the worker then follows the live market. Anyone can watch the dashboard and run the verifier.

Full deployment steps: [`docs/DEPLOY_FINAL.md`](docs/DEPLOY_FINAL.md). HTTP API: [`docs/API.md`](docs/API.md).

### Deploying the program yourself

```bash
cd contracts/fuse-anchor
anchor keys sync
anchor build
anchor test                 # init → arm → 61%/$300 → 28%/KILLED → $0, reopen rejected
anchor deploy --provider.cluster devnet
```

## Security status

A hackathon build running on devnet, not an audited protocol. A mainnet deployment would need an independent program audit, hardened key management (KMS/HSM), venue-authority review, monitoring and legal review. See [`docs/PRODUCTION.md`](docs/PRODUCTION.md) and [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

# KULT Fuse

**Turn probability into position — within a mandate Solana enforces.**

KULT Fuse is a Solana execution mandate. A live prediction-market probability drives a perpetual-futures position, but only inside a policy the user commits onchain before any capital moves: a fixed probability → exposure curve, a hard notional cap, an expiry and an absorbing kill switch. The Fuse program checks every target the execution agent submits against that committed curve, and every fill produces a tamper-evident receipt anchored onchain.

> **The agent proposes. The user authorizes. The policy executes. Solana verifies.**

## Links

> Fill these in before submitting.

| | |
|---|---|
| Live app | `TODO: public URL` |
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
- Flash unrealized P&L. The worker reads Flash `pnlWithFeeUsd`. If that P&L reaches −$50, the worker submits an authorized kill. The Fuse program stores `loss_stop_usd` and checks the submitted target; it does not read the Flash wallet or compute that P&L.

**Trust boundary.** Fuse checks the targets submitted to it. It does not control the Flash wallet. An onchain kill blocks new Fuse exposure. The worker sends the separate Flash close.

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
npm test                    # 22 deterministic tests

cp .env.example .env        # fill keys and operator token; market slug is in code
npm run preflight           # checks every required setting
npm run smoke:polymarket    # live quote for the chosen market
npm run smoke:flash         # read-only Flash devnet connection
npm start                   # http://localhost:8787
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

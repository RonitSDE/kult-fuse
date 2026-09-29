# KULT FUSE v1.2 — Submission Freeze

**Prediction probability → committed policy → bounded perp exposure.**

KULT Fuse is a Solana execution mandate. A prediction-market probability enters a precommitted piecewise policy; the policy determines the permitted SOL-perp exposure; hard caps, expiry, replay protection and an absorbing kill are enforced by the Fuse program; execution is reconciled against the actual venue position; every transition creates a tamper-evident receipt.

> **The agent proposes. The user authorizes. The policy executes. Solana verifies.**

## Live deployment

Everything runs on real data: a live Polymarket order book drives the probability, positions execute on Flash Trade devnet, and every commitment, kill and fill is a Solana devnet transaction against the deployed Fuse program.

- Public app: `PUBLIC_URL` (health: `PUBLIC_URL/healthz`)
- Fuse program: `FUSE_PROGRAM_ID`
- Current Fuse account and its transactions: shown live in the **Chain proof** panel and on every receipt (**ON-CHAIN ↗**)
- Tagged build: `BUILD_TAG` + `BUILD_SHA`

Anyone can watch the dashboard and run the independent verifier. Arming, killing, settling and starting a new mandate need the operator token (`FUSE_ADMIN_TOKEN`, entered via **OPERATOR LOGIN**).

## Local run

Requires Node.js 22.9+ and a filled `.env` (see `.env.example`).

```bash
cp .env.example .env      # then fill keys, market and token
npm test
npm run preflight
npm run smoke:polymarket
npm run smoke:flash
npm start
```

Open `http://localhost:8787`.

```bash
curl http://localhost:8787/healthz
curl http://localhost:8787/api/proof
```

## Repository

```text
contracts/fuse-anchor/     Anchor program
src/core/                  deterministic policy, risk, receipts, verifier
src/worker/                reconcile + execute engine
src/adapters/event/        Polymarket + DFlow prediction sources
src/adapters/perp/         Flash Trade + generic driver
src/adapters/store/        file + Anchor clients
src/http/                  API + static web server
web/                       live dashboard + operator controls
scripts/                   smoke, preflight, release checks
tests/                     deterministic unit/integration tests (+ fixtures)
docs/                      deploy, threat model, integrations
```

## Core policy

The v1 policy is intentionally auditable and **piecewise**, not continuous:

| Event probability | Target SOL-perp notional |
|---:|---:|
| `<35%` | `$0` + absorbing KILL |
| `35–49.99%` | `$100` |
| `50–59.99%` | `$200` |
| `60–69.99%` | `$300` |
| `70–79.99%` | `$420` |
| `>=80%` | `$500` hard cap |

Normal band changes require confirmation + hysteresis. Kill bypasses debounce.

## Trust boundary

### Program-enforced

- policy commitment / curve parameters
- `P → E(P)` target validation
- hard notional cap
- lifecycle state machine
- absorbing KILL
- expiry: no risk increases
- oracle sequence replay protection
- execution nonce replay protection
- authorized owner/oracle/execution roles

### External / attested in v1

- prediction venue data itself
- Flash venue fills
- offchain transaction construction
- offchain P&L/loss-stop calculations

The worker cannot submit a policy target larger than the onchain curve permits through the Fuse program. A separately provisioned venue wallet must still be operationally restricted and reconciled; see `docs/THREAT_MODEL.md`.

## Prediction source: Polymarket

The worker reads the configured Polymarket market's live order book (public Gamma + CLOB APIs, no key), derives a midpoint probability from the chosen outcome's best bid/ask, and rejects stale/wide-spread observations before they may increase risk. A mandate never outlives its market: the policy expiry is capped at the market's end date.

```bash
EVENT_SOURCE=polymarket
POLYMARKET_MARKET=<slug from polymarket.com/market/<slug>>
POLYMARKET_OUTCOME=Yes
```

```bash
npm run smoke:polymarket
```

DFlow / Kalshi is also supported with `EVENT_SOURCE=dflow`, `DFLOW_API_KEY` and `DFLOW_MARKET_MINT` (`npm run smoke:dflow`).

## Perp venue: Flash Trade

The submission build uses a Flash Trade adapter behind the stable Fuse `PerpAdapter` interface. The devnet proof path uses Flash's mature `flash-sdk` pool configuration (`devnet.1`) because it provides a documented open / increase / decrease / close lifecycle suitable for chain proof.

Install optional live dependencies:

```bash
npm install
```

Configure:

```bash
PERP_ADAPTER=flash
FLASH_CLUSTER=devnet
FLASH_POOL=devnet.1
FLASH_PRIVATE_KEY_JSON='[...]'
FLASH_TARGET_SYMBOL=SOL
FLASH_COLLATERAL_SYMBOL=USDC
FLASH_LEVERAGE_X=1
```

Read-only connection test:

```bash
npm run smoke:flash
```

Tiny devnet lifecycle:

```bash
CONFIRM_FLASH_SMOKE=YES \
FLASH_SMOKE_OPEN_USD=20 \
FLASH_SMOKE_RESIZE_USD=30 \
npm run smoke:flash
```

Expected proof: **open → resize → close → residual exposure ≈ 0**, with the real signatures copied into the proof env fields.

> Do not run mainnet smoke unless intentionally reviewed. Mainnet is blocked unless `CONFIRM_FLASH_MAINNET=YES` is explicitly set.

## Anchor program

The source is under `contracts/fuse-anchor`.

Your deployment environment needs Rust, Solana CLI and Anchor 0.31.x.

```bash
cd contracts/fuse-anchor
anchor keys sync
anchor build
anchor test
anchor deploy --provider.cluster devnet
```

The included `anchor test` runs a local integration smoke covering `init → arm → 61%/$300 → 28%/KILLED → $0` and asserts a killed Fuse cannot reopen.

Then set `FUSE_PROGRAM_ID` and the owner / oracle / execution keys. The server creates its own Fuse account on first boot (committed to the live policy and market) and a new one for each new mandate; see `docs/DEPLOY_FINAL.md`.

## API

Public:

- `GET /healthz`
- `GET /api/state`
- `GET /api/proof`
- `POST /api/verify` — independent policy/receipt verifier

Operator (require `Authorization: Bearer <FUSE_ADMIN_TOKEN>`):

- `POST /api/arm`
- `POST /api/tick` — poll the market now (the worker also polls continuously)
- `POST /api/kill`
- `POST /api/settle`
- `POST /api/fuse/new` — start the next mandate after a kill/settle

## Production deployment gate

Before submission, run:

```bash
npm test
npm run release:check
```

Then complete the external proof checklist:

1. Anchor build/test passes.
2. Fuse program deployed to Solana devnet.
3. Server boots, creates its Fuse account, and the operator arms it.
4. Live market moves drive real target changes, fills and receipts.
5. Flash devnet `$20 → $30 → $0` lifecycle passes.
6. Public URL and `/healthz` are continuously reachable.
7. Optional pinned proof txs are populated in `.env`.
8. Final commit is tagged and `BUILD_SHA` matches that commit.
9. Record the video from that exact deployment.

## Security status

This is a **submission-ready deployment candidate**, not an audited real-money protocol. Mainnet deployment requires independent smart-contract review, key-management hardening, venue/session-authority review, monitoring, incident procedures and jurisdiction-specific legal review.

See `docs/THREAT_MODEL.md` and `docs/DEPLOY_FINAL.md`.
# kult-fuse

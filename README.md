# KULT FUSE v1.2 — Submission Freeze

**Prediction probability → committed policy → bounded perp exposure.**

KULT Fuse is a Solana execution mandate. A prediction-market probability enters a precommitted piecewise policy; the policy determines the permitted SOL-perp exposure; hard caps, expiry, replay protection and an absorbing kill are enforced by the Fuse program; execution is reconciled against the actual venue position; every transition creates a tamper-evident receipt.

> **The agent proposes. The user authorizes. The policy executes. Solana verifies.**

## Judge fast path

After deployment, fill these links before submission:

- Public demo: `PUBLIC_DEMO_URL`
- Health: `PUBLIC_DEMO_URL/healthz`
- Fuse program: `FUSE_PROGRAM_ID`
- Example Fuse PDA: `FUSE_PDA`
- Create tx: `PROOF_CREATE_TX`
- Kill tx: `PROOF_KILL_TX`
- Flash open / resize / close: `PROOF_FLASH_OPEN_TX`, `PROOF_FLASH_RESIZE_TX`, `PROOF_FLASH_CLOSE_TX`
- Tagged build: `BUILD_TAG` + `BUILD_SHA`

### One-click Judge Demo

Click **RUN JUDGE DEMO**:

`61% → $300 → 72% → $420 → simulated 28% shock → KILLED → $0 → VERIFIED`

The Judge Demo intentionally uses a **simulated probability input and paper fills** so presentation reliability does not depend on external venues. Real devnet proof is displayed separately in the **Chain Proof** panel.

## Local run

Requires Node.js 20+.

```bash
cp .env.example .env
npm test
npm run simulate
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
src/adapters/event/        manual + DFlow prediction sources
src/adapters/perp/         paper + Flash Trade + generic driver
src/adapters/store/        file + Anchor clients
src/http/                  API + static web server
web/                       interactive judge frontend
scripts/                   simulation, smoke, preflight, release checks
tests/                     deterministic unit/integration tests
docs/                      deploy, threat model, integrations, judge script
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

## Prediction source: DFlow / Kalshi

Live mode reads the configured DFlow market orderbook, derives a midpoint probability, and rejects stale/wide-spread observations before they may increase risk.

Configure:

```bash
KULT_FUSE_MODE=live
DFLOW_API_KEY=...
DFLOW_MARKET_MINT=...
```

Smoke:

```bash
npm run smoke:dflow
```

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

Then populate:

```bash
FUSE_ONCHAIN=1
FUSE_PROGRAM_ID=...
FUSE_PDA=...
FUSE_IDL_PATH=./contracts/fuse-anchor/target/idl/kult_fuse.json
```

Initialize/operate using the included Anchor client and deployment instructions in `docs/DEPLOY_FINAL.md`.

## API

Public/read endpoints:

- `GET /healthz`
- `GET /api/state`
- `GET /api/proof`

Mutation endpoints:

- `POST /api/reset`
- `POST /api/arm`
- `POST /api/probability` — demo only
- `POST /api/tick`
- `POST /api/chaos` — demo only, explicitly simulated
- `POST /api/kill`
- `POST /api/settle`
- `POST /api/verify`
- `POST /api/replay`

In `KULT_FUSE_MODE=live`, POST mutations require:

```http
Authorization: Bearer <FUSE_ADMIN_TOKEN>
```

## Production deployment gate

Before submission, run:

```bash
npm test
npm run simulate
npm run release:check
```

Then complete the external proof checklist:

1. Anchor build/test passes.
2. Fuse program deployed to Solana devnet.
3. Real Fuse PDA created and armed.
4. Real program kill/state transition recorded.
5. Flash devnet `$20 → $30 → $0` lifecycle passes.
6. Public URL and `/healthz` are continuously reachable.
7. Proof txs are populated in `.env`.
8. Final commit is tagged and `BUILD_SHA` matches that commit.
9. Record the video from that exact deployment.

## Security status

This is a **submission-ready deployment candidate**, not an audited real-money protocol. Mainnet deployment requires independent smart-contract review, key-management hardening, venue/session-authority review, monitoring, incident procedures and jurisdiction-specific legal review.

See `docs/THREAT_MODEL.md` and `docs/DEPLOY_FINAL.md`.
# kult-fuse

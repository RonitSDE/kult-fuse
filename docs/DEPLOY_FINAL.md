# Final deployment runbook

This is the only runbook the submission deployer should need. Everything runs on live data: Polymarket for probability, Flash Trade devnet for execution, the Fuse program on Solana devnet for commitments.

## 1. Freeze the build

```bash
git status
git tag submission-2026-10-09
export BUILD_TAG=submission-2026-10-09
export BUILD_SHA=$(git rev-parse HEAD)
```

Do not record the video from a different commit.

## 2. Install and local validation

```bash
npm install
npm test
```

## 3. Deploy the Anchor program to devnet

```bash
cd contracts/fuse-anchor
anchor keys sync
anchor build
anchor test   # runs the included local end-to-end policy/kill smoke
anchor deploy --provider.cluster devnet
```

Save the program ID and transaction signature. Keep `target/deploy/kult_fuse-keypair.json` safe; it is needed for upgrades.

## 4. Configure the runtime

Copy `.env.example` to `.env` and set at minimum:

```bash
FUSE_ADMIN_TOKEN=<24+ char random token>
SOLANA_CLUSTER=devnet
SOLANA_RPC_URL=<devnet RPC>
EVENT_SOURCE=polymarket
POLYMARKET_MARKET=<active market slug>
PERP_ADAPTER=flash
FLASH_CLUSTER=devnet
FLASH_POOL=devnet.1
FLASH_PRIVATE_KEY_JSON='[...]'
FUSE_PROGRAM_ID=<program>
FUSE_OWNER_PRIVATE_KEY_JSON='[...]'
FUSE_EXECUTION_PRIVATE_KEY_JSON='[...]'
FUSE_ORACLE_PRIVATE_KEY_JSON='[...]'
BUILD_TAG=submission-2026-10-09
BUILD_SHA=<git sha>
```

Use separate owner / oracle / execution / Flash keys. Fund each with devnet SOL; fund the Flash key with Flash devnet USDC (enough collateral for the policy's hard cap at `FLASH_LEVERAGE_X`).

Pick a Polymarket market that is open, liquid (tight spread, within the policy's `maxSpreadBps`) and whose current probability sits inside the policy curve (`POLICY_FILE`, default `policy.example.json`).

```bash
npm run preflight
```

## 5. Live data smoke

```bash
npm run smoke:polymarket   # live bid/ask and quality check for the chosen market
npm run smoke:flash        # read-only Flash connection
```

Then a tiny Flash execution:

```bash
CONFIRM_FLASH_SMOKE=YES \
FLASH_SMOKE_OPEN_USD=20 \
FLASH_SMOKE_RESIZE_USD=30 \
npm run smoke:flash
```

Capture open, resize and close signatures into `PROOF_FLASH_*`. Confirm residual exposure is zero.

## 6. Start and arm

```bash
npm start   # or: docker compose -f deploy/compose.yaml up --build
```

On first boot the server creates its Fuse account onchain, committed to the live policy and market. Check:

```bash
curl $PUBLIC_URL/healthz     # "onchain": true, "market": "<slug>"
curl $PUBLIC_URL/api/proof
```

Open the app, click **OPERATOR LOGIN**, enter `FUSE_ADMIN_TOKEN`, then **ARM FUSE**. The worker now polls the market and trades within the mandate. After a kill or settle, **NEW MANDATE** creates the next Fuse account.

## 7. Public hosting

Build the provided Docker image or run Node directly. Put TLS/reverse proxy in front of the service. Keep `.env` and wallet keys outside the image. The `.data` volume holds the current Fuse binding and receipts; keep it persistent.

Health check path: `/healthz`.

## 8. Final release gate

```bash
npm run release:check
```

Manually verify:

- Receipts show live probabilities and **ON-CHAIN ↗** links that open on Solscan.
- Chain proof panel shows the program and current Fuse account.
- Independent verifier passes.
- No private keys/API keys are in Git.
- Public app and health endpoint load from a private/incognito browser.

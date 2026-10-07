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

The live market slug is `DEFAULT_POLYMARKET_MARKET` in `src/adapters/event/polymarket-event.mjs` (Will Bitcoin reach $95,000 by December 31, 2026?). Change that constant to move the mandate. It must stay open, liquid, and inside the policy curve.

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

Build the provided Docker image or run Node directly. Put TLS/reverse proxy in front of the service. Keep `.env` and wallet keys outside the image. The `.data` volume holds the current Fuse binding and receipts; keep it persistent. If that directory is empty on boot and Flash still has a position, the server refuses to create a new mandate.

Health check path: `/healthz`.

### Render

`render.yaml` is a starter web service (Node 22.14) with a 1 GB disk mounted at `/var/data`. A free instance cannot keep that disk and will sleep, which stops the worker.

1. Push this repo to GitHub.
2. In Render: **New** → **Blueprint**, select the repo, and fill every `sync: false` variable (three Fuse keys, Flash key, `BUILD_SHA`, `PUBLIC_URL`). The market slug is in the source. `FUSE_ADMIN_TOKEN` is generated; copy it from the service environment to sign in as operator.
3. After the first deploy, set `PUBLIC_URL` to the `https://….onrender.com` address and `BUILD_SHA` to `git rev-parse HEAD`, then redeploy.
4. Confirm `https://<service>.onrender.com/healthz` returns `"onchain": true` and the configured market.

### Cloudflare Pages frontend (optional)

The dashboard in `web/` can be served from Cloudflare Pages while the backend stays on Render. `functions/_middleware.js` forwards `/api/*` and `/healthz` to the backend, so the browser only ever talks to the Pages origin.

1. In Cloudflare: **Workers & Pages** → **Create** → **Pages** → connect the repo.
2. Framework preset **None**, build command empty, build output directory `web`, root directory `/`.
3. Environment variables: `BACKEND_URL=https://<service>.onrender.com` and `SKIP_DEPENDENCY_INSTALL=1` (the frontend has no dependencies).
4. On Render, set `PUBLIC_URL` to the `https://<project>.pages.dev` address.
5. Confirm `https://<project>.pages.dev/healthz` returns `"onchain": true`, then sign in as operator from the Pages URL.

To upload from a checkout instead of connecting the repo, run `npx wrangler pages deploy` from the repo root; `wrangler.toml` supplies the project name, output directory and `BACKEND_URL`.

For a manual dashboard upload, run `npm run build:pages` and upload the generated `dist/` folder (**Create** → **Pages** → **Upload assets**). It contains the dashboard and a `_worker.js` with the same proxy.

The Render service must stay running: it holds the keys, the worker and the `.data` disk.

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

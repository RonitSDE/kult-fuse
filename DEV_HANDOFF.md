# KULT Fuse v1.2 — Dev Handoff

This is the submission-freeze source. Do not add product features before the proof gates below pass.

## 1. Install

```bash
cp .env.example .env
npm install
npm test
npm run simulate
npm run release:check
```

Expected local result: **14/14 PASS** and `RELEASE CHECK PASS`.

## 2. Build + test the Fuse program

Install Solana + Anchor 0.31.x, then:

```bash
cd contracts/fuse-anchor
anchor keys sync
anchor build
anchor test
```

The included Anchor test proves:

`init → arm → P=61%/$300 → P=28%/KILLED → fill $0 → reopen rejected`

## 3. Deploy Fuse to Solana devnet

```bash
anchor deploy --provider.cluster devnet
cd ../..
```

Populate `.env` with `FUSE_PROGRAM_ID` and the authority keys. Run:

```bash
npm run anchor:init
```

Copy the returned Fuse PDA and create tx into `.env`.

## 4. DFlow live-data smoke

Configure `DFLOW_API_KEY` + `DFLOW_MARKET_MINT`, then:

```bash
npm run smoke:dflow
```

Use an active market with acceptable spread/depth for the recorded live proof.

## 5. Flash Trade devnet smoke

Configure the funded devnet wallet and Flash fields. First:

```bash
npm run smoke:flash
```

Then execute the tiny proof lifecycle:

```bash
CONFIRM_FLASH_SMOKE=YES \
FLASH_SMOKE_OPEN_USD=20 \
FLASH_SMOKE_RESIZE_USD=30 \
npm run smoke:flash
```

Required result: **open → resize → close → residual ≈ 0**. Save all signatures.

## 6. Live service config

Set:

```bash
KULT_FUSE_MODE=live
PERP_ADAPTER=flash
FUSE_ONCHAIN=1
FUSE_PDA=<created PDA>
FUSE_ADMIN_TOKEN=<strong random token>
BUILD_TAG=submission-2026-10-09
BUILD_SHA=<exact git commit>
PUBLIC_DEMO_URL=https://<your-public-demo>
```

Populate all `PROOF_*_TX` fields.

## 7. Public deploy

Deploy with the provided Dockerfile/compose or Node service. Confirm externally:

```bash
curl https://<demo>/healthz
curl https://<demo>/api/proof
```

The frontend must show **DEVNET LIVE** and clickable Chain Proof links.

## 8. Final freeze

```bash
npm run preflight
npm run release:check
git tag submission-2026-10-09
```

Confirm:

- Judge Demo: `61 → $300 → 72 → $420 → simulated 28 → KILLED/$0 → VERIFIED`
- Judge Demo is clearly labelled simulation/paper execution.
- Chain Proof separately shows real Solana + Flash devnet signatures.
- `/healthz` shows the exact tag/SHA/network/program/venue.
- No keys or `.env` are committed.
- Video is recorded from the tagged public deployment.

Then submit. Do not add another venue/oracle/agent feature before these gates are complete.

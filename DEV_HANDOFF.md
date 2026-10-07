# KULT Fuse v1.2 — Dev Handoff

This is the submission-freeze source. Do not add product features before the proof gates below pass.

## 1. Install

```bash
cp .env.example .env
npm install
npm test
npm run release:check
```

Expected local result: **23/23 PASS** and `RELEASE CHECK PASS` (preflight needs a filled `.env`).

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

Populate `.env` with `FUSE_PROGRAM_ID` and the owner / oracle / execution keys. The server creates its own Fuse account on first boot.

## 4. Polymarket live-data smoke

The market slug is `DEFAULT_POLYMARKET_MARKET` in `src/adapters/event/polymarket-event.mjs`. Then:

```bash
npm run smoke:polymarket
```

Use a market with a tight spread whose probability sits inside the policy curve.

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
PERP_ADAPTER=flash
FUSE_ADMIN_TOKEN=<strong random token>
BUILD_TAG=submission-2026-10-09
BUILD_SHA=<exact git commit>
PUBLIC_URL=https://<your-public-host>
```

Optionally pin the Flash smoke signatures in `PROOF_FLASH_*_TX`.

## 7. Public deploy

Deploy with the provided Dockerfile/compose or Node service. Confirm externally:

```bash
curl https://<host>/healthz
curl https://<host>/api/proof
```

The frontend must show **DEVNET LIVE** and clickable Chain Proof links.

## 8. Final freeze

```bash
npm run preflight
npm run release:check
git tag submission-2026-10-09
```

Confirm:

- Operator login → ARM; the worker trades the live market within the mandate.
- Receipts carry ON-CHAIN links; the verifier passes.
- Chain Proof shows the program and current Fuse account.
- `/healthz` shows the exact tag/SHA/network/program/venue.
- No keys or `.env` are committed.
- Video is recorded from the tagged public deployment.

Then submit. Do not add another venue/oracle/agent feature before these gates are complete.

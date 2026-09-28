# Final deployment runbook

This is the only runbook the submission deployer should need.

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
npm run simulate
```

## 3. Deploy the Anchor program to devnet

```bash
cd contracts/fuse-anchor
anchor keys sync
anchor build
anchor test   # runs the included local end-to-end policy/kill smoke
anchor deploy --provider.cluster devnet
```

Save the program ID and transaction signature.

## 4. Configure the runtime

Set at minimum:

```bash
KULT_FUSE_MODE=live
SOLANA_CLUSTER=devnet
SOLANA_RPC_URL=<OrbitFlare devnet-compatible RPC>
DFLOW_API_KEY=<key>
DFLOW_MARKET_MINT=<active market>
PERP_ADAPTER=flash
FLASH_CLUSTER=devnet
FLASH_POOL=devnet.1
FLASH_PRIVATE_KEY_JSON='[...]'
FUSE_ONCHAIN=1
FUSE_PROGRAM_ID=<program>
FUSE_PDA=<example fuse account>
FUSE_OWNER_PRIVATE_KEY_JSON='[...]'
FUSE_EXECUTION_PRIVATE_KEY_JSON='[...]'
FUSE_ORACLE_PRIVATE_KEY_JSON='[...]'
FUSE_ADMIN_TOKEN=<strong random token>
BUILD_TAG=submission-2026-10-09
BUILD_SHA=<git sha>
```

Use separate owner/oracle/execution keys for the demo if practical.

## 5. Flash devnet proof

First read only:

```bash
npm run smoke:flash
```

Then tiny execution:

```bash
CONFIRM_FLASH_SMOKE=YES \
FLASH_SMOKE_OPEN_USD=20 \
FLASH_SMOKE_RESIZE_USD=30 \
npm run smoke:flash
```

Capture open, resize and close signatures. Confirm residual exposure is zero.

## 6. Populate proof metadata

```bash
PROOF_CREATE_TX=...
PROOF_ARM_TX=...
PROOF_KILL_TX=...
PROOF_FLASH_OPEN_TX=...
PROOF_FLASH_RESIZE_TX=...
PROOF_FLASH_CLOSE_TX=...
```

Restart the service. Verify:

```bash
curl $PUBLIC_DEMO_URL/healthz
curl $PUBLIC_DEMO_URL/api/proof
```

The frontend Chain Proof panel should now show clickable links and `DEVNET LIVE`.

## 7. Public hosting

Build the provided Docker image or run Node directly. Put TLS/reverse proxy in front of the service. Keep `.env` and wallet keys outside the image.

Health check path: `/healthz`.

## 8. Final release gate

```bash
npm run release:check
```

Manually verify:

- Judge Demo: 61 → 300; 72 → 420; 28 → killed/0; verifier PASS.
- Chain Proof links open on explorer.
- Flash live proof is separately labelled from Judge Simulation.
- No private keys/API keys are in Git.
- Public demo and health endpoint load from a private/incognito browser.

## 9. Submission wording

Do **not** say the paper Judge Demo is a live market execution. Say:

> The one-click Judge Demo uses a deterministic event shock so the policy can be tested on demand. Separately, the Chain Proof panel exposes the deployed Fuse account and real Flash Trade devnet execution receipts.

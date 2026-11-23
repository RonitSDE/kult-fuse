# KULT Fuse v2.1.0 Devnet handoff

## Deploy the public build

Use Node 24 and one application process on a persistent disk. Start from the ZIP's root directory.

```bash
cp .env.example .env
npm ci
npm run predict:install
npm test
npm run predict:check
npm run predict:build
npm run predict:preflight
npm start
```

Set these values before the build and preflight.

| Setting | Value |
| --- | --- |
| `SOLANA_CLUSTER` | `devnet` |
| `PREDICT_DEVNET_RPC` | Server HTTPS RPC for Solana Devnet, preferably with reliable transaction history. |
| `VITE_DEVNET_RPC` | Browser-safe HTTPS Devnet RPC with CORS and WebSocket access. Values compiled with the `VITE_` prefix are public. |
| `PREDICT_ATTESTATION_KEY` | Stable server secret generated with `openssl rand -hex 32`. Keep it in server settings only. Retain the same key throughout the run and across restarts. |
| `DATA_DIR`, `PREDICT_RECEIPTS_FILE` | Writable persistent locations. Back up the receipt file and retain it across deploys. |
| `BUILD_SHA` | Deployed 40-character Git commit. Render can expose it through `RENDER_GIT_COMMIT`. |
| `VITE_FEATURED_VAULTS` | Featured vault PDA for judges. The app also supports `/?vault=<PDA>#vaults`. |
| `VITE_FEATURED_MARKETS` | Optional featured PREDICT market PDA after launch. The vault links directly to its launched market. |
| `PUBLIC_URL` | Public HTTPS app origin. |
| `PREDICT_LIFECYCLE_FILE` | Optional path on the persistent disk for the verified proof pack. |

The pinned sponsor SDK is `@pm-amm/sdk@0.2.0`. Confirm the public `/api/predict/config` reports the expected Git commit and finalized scoring. Check `/api/predict/ready` separately for Devnet RPC identity, deployed executable program, and receipt readability.

Deploy with the supplied Render Blueprint or use `docker compose --env-file .env -f deploy/compose.yaml up -d --build`. For Docker, terminate HTTPS at your ingress and preserve the Compose volume. Keep the perps worker disabled. Use the public root URL for judges.

After deployment, open the public link on desktop and mobile. Start a test wallet, request faucet funds, choose the featured market, approve limits and perform one real 1 mUSDC swap. Check the Solscan receipt, the finalized scoreboard row and the public receipt URL after a process restart. Verify refusal above the cap and while paused. Keep the test wallet tab open through settlement.

## Run one featured market end to end

1. Choose a binary event with an outcome observable before judging. Record the deadline in UTC, outcome rules and public resolution source. Set `PREDICT_VAULT_QUESTION`, `PREDICT_VAULT_COMMIT_SEC`, `PREDICT_VAULT_TARGET_MUSDC`, `PREDICT_MARKET_DURATION_SEC` and the path to a funded test-only builder keypair. Use a separate wallet from normal users and keep the keypair outside the repo and web service.
2. Run `npm run predict:vault:create`. Record the vault PDA and signature. Share `/?vault=<vault-pda>#vaults` with participants and curate that PDA in the deployment. At least two participant wallets should fund the vault across both sides. Record their commitment signatures from the decision journals.
3. Set `PREDICT_VAULT_PDA` after commitments close and meet the target. Run `npm run predict:vault:launch`. Record the market PDA and launch signature. The launch payer covers rent. The vault view reads the launched market address and initial YES price from the SDK account.
4. Have participants trade both sides. Record at least three finalized buys from two or more wallets. Record the finalized signatures from the public feed and track tester participation separately so developer wallets can be disclosed. A distinct key can belong to the same person.
5. After trading closes, set `PREDICT_RESOLVE_MARKET`, `PREDICT_RESOLVE_SIDE` and `PREDICT_RESOLUTION_EVIDENCE_URL`. Run `npm run predict:market:resolve` using the authority shown on the market account. Record the signature and have a verified trading wallet holding the winning token click **Claim winnings**. Record the claim signature after finality. A vault LP allocation claim uses a separate PREDICT instruction.
6. Record a short demo from this release. Show the featured vault, its funding and opening price, a real transaction progressing through finality, the scoreboard and the resulting claim. Include the featured vault URL and its finalized signatures in the submission.

A first Devnet run can use 10 mUSDC of target liquidity and a 10-minute commit window. Set a market window long enough for testers to trade before the chosen event resolves.

## Generate the evidence

Copy `docs/predict-lifecycle.example.json` outside the source tree and fill its addresses, transaction signatures and public resolution evidence URL. Set `PREDICT_LIFECYCLE_INPUT`, `PREDICT_VIDEO_URL`, `PUBLIC_URL` and `BUILD_SHA`. Run:

```bash
npm run predict:submission
```

The gate requires a public app reporting the same SHA, a reachable video URL, and verified transactions for vault creation, funding, launch, swaps, resolution and a positive claim. It cross-checks the deployed scoreboard receipts against finalized Devnet RPC data and writes `predict-proofs.json` only after the checks pass. Use `PREDICT_PROOFS_OUT` for a different destination. Transfer the resulting file to the server path configured by `PREDICT_LIFECYCLE_FILE` to surface explorer links in the vault view. Copy verified facts into `SUBMISSION_MANIFEST.json` for the submission. Attach the video and public evidence links.

The check measures distinct signed addresses and video URL availability. Review tester independence, recording contents, settlement source and UX manually. The thresholds are local submission requirements. See the [PREDICT builder kit](https://predict-pm-amm.dev/hackathon.md).

## Operator notes

- The Fuse API creates an HMAC attestation for the wallet, market, blockhash, side, spend and minimum. It expires for new transactions after two minutes. A valid attestation proves Fuse API involvement, including callers using that API outside the browser. A signed transaction and the verifier establish the actual execution.
- The registry deduplicates finalized transactions and attestation IDs. Use one process per file. Existing v2.0.2 receipts stay on disk and are excluded from the v2.1.0 scoreboard. The read-only feed and per-signature endpoints survive reloads and restarts.
- Spending controls are scoped to the Fuse browser and selected market. The browser reserves budget once it creates a signed swap, so a lost broadcast reply cannot prompt an automatic repeat. The saved signature can be checked again without resending. Pausing stops new Fuse swaps. A broadcast transaction can still settle. Reservations may remain until the hour expires.
- The Devnet test wallet is saved in the participant's browser (localStorage), so they can close the tab and return to sell or claim. v2.0.x and v2.1.0 wallets carry over automatically. Test funds only. Builder credentials belong on the developer's machine only.
- Swaps reported before finality are queued on the server's disk and finalized in the background (`PREDICT_RECONCILE_MS`, default 10 s), so a trade counts even if the tab closed first.
- Resolution uses the PREDICT market authority. Keep the release on Devnet and complete an actual hosted lifecycle run before submission.

# KULT Fuse v2.0.2 — devnet deployment fixes

Built on v2.0.1. Same scope and truth boundary: devnet only, mock USDC, app-side mandates, manual market resolution by the creator.

## Fixed (each would have hurt the live devnet run)

1. **Wrong odds and failing buys on quiet markets.** The program stores pool reserves as of `lastAccrualTs` and accrues before every swap; reserves scale with L_eff = L0·√(T−t) (`accrual.rs`). v2.0.1 (following PREDICT's quickstart example) priced stored reserves against L_eff *now*, so a market untouched for a while showed odds pushed away from 50% (a 62% market read ~77% after 50 quiet minutes in the test) and quoted a minimum output the swap could not meet. Reserves are now rescaled to now first, as PREDICT's own reference app does (`app/src/hooks/use-markets.ts`). `src/predict/pricing.mjs`, tested.
2. **Trades never verified.** The verifier read transactions at `finalized`, but the app submits them right after `confirmed`, about 13 seconds before finality, so the first check found nothing and the trade was never counted. It now reads at `confirmed` and retries briefly.
3. **Traction could be inflated by anyone.** Any PREDICT swap by any wallet could be submitted and counted. App swaps now carry a signed `kult-fuse:predict:v2` SPL Memo in the same transaction (same instructions as the SDK's `send.swap`, plus the memo; 832 of 1,232 bytes), and the verifier only counts swaps with it. `PREDICT_REQUIRE_APP_MEMO=0` turns this off explicitly.
4. **Docker image could not build.** The app imports `src/predict/*`, which the builder stage never copied. Fixed; the stage now uses a committed `apps/predict/package-lock.json` with `npm ci` and takes the `VITE_*` values as build args.
5. **Transaction confirmation blocked by CSP.** web3.js confirms over a websocket; the policy allowed only `https://`. `wss://` for each configured RPC is now allowed.
6. **Perps lab API broken under `/perps/`.** Its relative `api/...` calls resolved to `/perps/api/...` and got the Predict HTML. `/perps/api/*` and `/perps/healthz` are now routed to the API, and `/perps` redirects to `/perps/`.
7. An inline style the CSP blocked was moved to CSS, and copy follows the no-"bet" wording rule.

## Verified here

- `npm ci` and 144 tests pass (the 140 from v2.0.1, plus the memo, pricing and retry tests; three fixtures updated to include the memo).
- `apps/predict`: `npm ci`, `check` and the Vite production build pass (v2.0.1 listed the build as unverified).
- The tagged swap transaction was built offline with the real SDK 0.2.0: 8 instructions, 832 bytes, the swap decodes with the program IDL, and the memo is signed by the swapper.
- The server serves `/`, deep links, `/perps/`, `/perps/api/state`, `/api/predict/*` and the CSP above.

## Not verified (no devnet access from the build machine)

A live swap, vault commit, launch, claim and the verifier on a real signature. Do these first, on the deployed URL, before recording.

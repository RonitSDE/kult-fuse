# PREDICT SDK 0.2.0 source compatibility — KULT Fuse v2.0.1

Reviewed against the user-supplied `pm-amm-main.zip`: `HACKATHON.md`, `packages/sdk/src/math.ts`, `packages/sdk/src/client.ts`, `packages/sdk/src/constants.ts`, `packages/sdk/src/pda.ts`, `anchor/programs/pm_amm/src/lib.rs`, `idl/pm_amm.json` and `examples/quickstart-devnet/index.cjs`.

## Confirmed interfaces
- Program: `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y`
- Devnet collateral: `3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ` (mUSDC, 6dp)
- Anchor swap instruction: `swap`, discriminator `[248,198,158,145,225,117,135,200]` (**not** `swap_yes_no`).
- PDA seeds: `["yes_mint", market]` and `["no_mint", market]`; verifier now requires outcome balance increases for one of these exact mints.
- Quote math: `@pm-amm/sdk/math` `i80f48ToNumber`, `priceFromReserves`, `estimateSwapOutput` with fee-aware net input.
- Swap via `client.send.swap(market, "usdcToYes"|"usdcToNo", rawAmountIn, rawMinOutput)`.
- The 2% USDC-leg fee is an input deduction on buys; returned quote is an estimate.

## What changed from v2.0
1. Removed dependency on an undocumented remote helpers endpoint and fail-closed placeholder.
2. Corrected independent receipt verifier to use the real swap discriminator and exact selected-market YES/NO mint PDAs, not arbitrary outcome tokens.
3. Prevented browsing or buying non-mUSDC markets in the devnet-only user experience.
4. Allowed browser RPC and faucet connections in CSP for the PREDICT homepage, without relaxing the legacy perps page.
5. Updated UX copy to disclose SDK-estimated prices and slippage-based onchain bounds.

## Still required before calling this launch ready
Install exact SDK v0.2.0 with Node 24; run Vite build, SDK smoke, Anchor program checks and actual devnet create/commit/launch/swap/claim. Record independently verified transaction signatures and publish a public URL. The user-supplied source is a reference, not proof that a deployed PREDICT market was used by KULT Fuse. This release has no real onchain verification yet.

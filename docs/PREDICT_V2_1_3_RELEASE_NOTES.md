# KULT Fuse v2.1.3 — full PREDICT lifecycle on devnet

v2.1.2 let people buy and claim. v2.1.3 adds the exits and the fee check, so a participant can do everything the pm-AMM supports without leaving Fuse.

## What changed

**Sell before expiry**
- New "Your position" panel in the trade card shows YES and NO held on the selected market, with a sell amount, Max, an exact quote and the minimum received after slippage.
- The quote is exact pm-AMM curve math, not an estimate. Reserves are rescaled to the current time (√(time left)), the gross output is `y − L·g(u')` for YES (mirror for NO), and the 2% fee comes off the output, as the program does. Tests check that selling the tokens a buy produced returns the buy's input, and cross-check against `@pm-amm/sdk` `estimateSwapOutput` to 1e-4.
- Sells are attested and counted. `action: 'sell'` is part of the HMAC intent. The verifier requires the outcome-token debit to equal the attested amount exactly, the other outcome to stay unchanged, and the mUSDC credit to meet the signed minimum. A buy attestation replayed on a sell fails. YES→NO and NO→YES swaps are rejected.
- The scoreboard reports `buys` and `sells`, volume counts both legs, and the feeds label sells.

**SOL for network fees**
- The PREDICT faucet can skip its SOL drip. After funding, Fuse checks for ~0.012 SOL (fees plus first-time token-account rent) and tries one 0.05 SOL devnet airdrop. If that fails, the status line gives the wallet address and a faucet.solana.com link.
- The same check runs before every buy, sell, LP deposit, withdrawal and claim, so users see what's wrong before signing rather than a cryptic simulation error.

**Liquidity exit**
- The liquidity panel shows your LP position on the selected market.
- Before resolution: **Withdraw all liquidity** → `withdrawLiquidity` (all shares) → `redeemPair` for matched YES+NO, returning mUSDC. Any one-sided remainder is shown and stays sellable.
- After resolution: **Claim LP payout** → `claimLpResiduals` → `claimWinnings`.

## Verified here
- 159 tests pass. New tests cover sell attestation, sell token-delta checks, replay across actions, the direction allowlist, buy/sell stats and exact sell math against the SDK.
- `npm --prefix apps/predict run check` and `build` pass, and a browser render of the new panels shows no CSP errors.

## Not verified here (no devnet access from the build sandbox)
- Real sells, withdrawals and LP claims on devnet. Run one of each with each wallet type before recording.

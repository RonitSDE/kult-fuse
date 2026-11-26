# KULT Fuse v2.1.4: demo-ready fixes

## 1. LP payout reachable after resolution
- Resolved markets drop out of market discovery, so the market panel could never show **Claim LP payout** for them. The vault view now shows **Claim LP payout** whenever the selected vault's launched market is resolved.
- One resumable exit (`src/predict/lp-exit.mjs`) drives both the market panel and the vault view. Before every transaction it re-reads chain state (market, vault commitment, LP position, YES/NO balances) and picks the next step:
  - **before resolution:** claim vault allocation if unclaimed → `withdrawLiquidity` → `redeemPair` for matched pairs;
  - **after resolution:** claim vault allocation if unclaimed → `claimLpResiduals` (a `NoResidualsToClaim` reply is skipped) → `claimWinnings` when a winning balance exists.
- The whole exit is pinned to one wallet (`src/predict/pinned-wallet.mjs`). Chain reads, transaction building and signing all use the address active at the first click. Before every read, before each signing popup opens and after it returns, Fuse checks the extension's active account still matches. If it changed or disconnected, the flow stops with nothing further sent; switching back and clicking again resumes.
- Each receipt is written to the journal as soon as it confirms. If a later step fails (say, redemption after a successful withdrawal), the status says what was saved and where it stopped, and the same button resumes. The market panel shows **Finish withdrawal: redeem pairs** for that case.

## 2. Session recheck after the wallet popup
- `recheckBeforeBroadcast` (policy.mjs) runs after signing and before broadcast. It checks: the active wallet is unchanged, the signer is that wallet, the session is not paused, the market is still open and, for buys, that the session is unexpired, covers this market and still has budget.
- On any change nothing is sent; the signed transaction expires with its blockhash. Quote age is deliberately not rechecked here, because the signed minimum is enforced onchain.

## 3. Sells in the evidence checker
- `swaps` stays buys only, with YES and NO coverage and two or more wallets, as before.
- A new required `sell` field holds one finalized Fuse sell on the same market. `verifySellEvidence` (src/predict/evidence.mjs) requires:
  - a YES→mUSDC or NO→mUSDC swap;
  - the exact token debit, with the other outcome untouched and mUSDC ≥ the signed minimum;
  - landing after launch and before market close;
  - a matching public receipt (`action: 'sell'`, side, wallet, mint, slot, raw mUSDC received, finalized, Fuse-attested).
- The scoreboard must count at least one sell, and total volume must cover the buys plus the sell.
- Sell receipts now store `mUsdcReceivedRaw` and `outcomeAmountRaw`. v2.1.3 receipts fall back to `received`.
- The proof file schema is now `kult-fuse-devnet-lifecycle-v2` and includes the sell. The server accepts v1 and v2.

## Verified here
- 171 tests pass (12 new: wallet pinning, including a switch during the popup; the LP exit planner, including resume after a failed redemption; the broadcast recheck; sell evidence pass/fail cases; the legacy receipt fallback).
- App check and build pass. The page loads with no script errors.

## Not verified here (no devnet access from the build sandbox)
- A real withdrawal, redemption, vault LP payout and sell on devnet, and a full `npm run predict:submission` run.

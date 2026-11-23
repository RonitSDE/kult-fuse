# KULT Fuse v2.1.1

PREDICT Prediction Arena on Solana Devnet. A community funds a Commitment Vault, launches its pm-AMM market, trades YES and NO, and follows the market through resolution and claims. All collateral is test mUSDC.

Start with [the Devnet developer handoff](docs/PREDICT_V2_WINNING_HANDOFF.md). The release includes the compiled browser app, pinned dependency lockfiles, Render and Compose deployment files, and a submission evidence checker.

This package is ready for the developer's hosted Devnet smoke run. Public deployment, finalized lifecycle evidence, and participant traction must be established on the release build. The submission manifest leaves live proof fields empty.

The browser requires explicit approval for each trade. It locks the selected market, one-hour budget and slippage settings, and supports pausing an active session. PREDICT enforces the trader's signed minimum output onchain. The wallet is a Devnet test account saved in the participant's browser, so they can come back to sell, follow resolution and claim.

The public scoreboard counts finalized direct PREDICT buys that match a signed transaction, a short-lived Fuse API attestation, and Devnet token deltas. This demonstrates Fuse API participation. The perps lab remains available at /perps/.

# Integrations

**Signal: Kalshi via DFlow.** DFlow tokenizes every Kalshi market on Solana as SPL outcome mints. Fuse reads the YES mint's orderbook (`/api/v1/orderbook/by-mint`): best YES bid, YES ask as 1 − best NO bid, and top-of-book depth in USD. If the book is unavailable it falls back to the market's yesBid/yesAsk with no depth, which a policy with `minTopDepthUsd > 0` treats as THIN, so exposure can't rise. The dev host needs no key. `npm run markets` lists active markets and their YES mints. The oracle worker's honesty is still a trust assumption: it submits the observation to Fuse.

**Execution: Velocity.** Velocity is Drift v2's successor (program `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P`, same id on devnet and mainnet-beta; devnet collateral is dUSDT). The adapter places price-bounded immediate-or-cancel taker orders (Velocity's `OrderParamsBitFlag.ImmediateOrCancel`), then re-reads the account: no base change means no receipt. The verifier decodes `OrderActionRecord` fill events from the venue transaction with the SDK's own parser and matches them to the receipt's base delta. Ported from the Drift adapter against SDK 0.27.0; the live devnet fill is the gate that confirms it.

**Policy: the Fuse Anchor program.** Commits the policy hash and validates submitted targets. Records a receipt hash after the worker reports a fill. It does not hold the venue key and does not execute atomically with the venue.

**Retired:** Drift (replaced by Velocity, no state carried over) and Flash Trade (shut down). Both adapters were removed. Polymarket stays as an optional signal for non-Solana demos.

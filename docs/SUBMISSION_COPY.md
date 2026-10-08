# Submission Copy

Ready-to-paste text for hackathon submission forms.

## Name
**KULT Fuse**

## Tagline
**Turn probability into position — within a mandate Solana enforces.**

## One-line description
A Solana execution mandate that maps live prediction-market probability into bounded perpetual exposure under a precommitted, onchain-enforced and independently verifiable policy.

## Short description
Prediction markets price what may happen. Perpetual markets trade the consequence. KULT Fuse binds the two through a policy the user commits onchain before any capital moves. A live Polymarket probability maps to a target SOL-perp exposure; the Fuse program on Solana recomputes that target from the committed curve and rejects anything outside it, enforces the hard cap, expiry and an absorbing kill, and anchors a tamper-evident receipt for every fill. Flash Trade executes the delta and the worker reconciles against the venue's actual position.

The agent can propose the strategy. The user authorizes it. The policy governs it. Solana verifies it.

## Why it is different
KULT Fuse is not another prediction market, perp DEX or AI trading bot. The product is the **verifiable relationship between markets**: probability becomes executable state, but only within a mandate fixed before capital moves. The execution agent cannot size beyond the committed curve, cannot skip the kill, and cannot reopen a killed mandate.

## How it works
1. **Commit** — the policy (curve, cap, kill threshold, expiry) is hashed into a Fuse account on Solana.
2. **Observe** — the oracle worker reads the live Polymarket order book; stale or wide quotes can never increase risk.
3. **Authorize** — the program recomputes the curve onchain and accepts only the matching target.
4. **Execute** — Flash Trade moves the SOL-perp position; the worker reconciles against the venue.
5. **Prove** — every fill produces a hash-chained receipt anchored onchain; anyone can run the verifier.

## Live proof points
- Live Polymarket probability drives the target: 60–69.99% → $300, 70–79.99% → $420
- Probability below 35% → absorbing onchain kill; the only permitted action afterwards is closing to $0
- Fuse create, arm, target and kill are confirmed Solana devnet transactions linked from the Chain Proof panel
- Flash Trade devnet fills have not landed: the live devnet market is not delegated to the rollup (Flash-admin only), so no venue signatures are claimed
- Independent verifier → policy compliance verified

## Built with
Solana, Anchor, Polymarket (Gamma + CLOB APIs), Flash Trade (`flash-sdk`), Node.js.

## Solana-native reason
Solana is the coordination and proof layer: a compact policy account commits the mandate, enforces bounds and lifecycle, and anchors execution receipts, while existing prediction and perp liquidity stays external and composable. Fast, cheap transactions make it practical to commit every target change and fill onchain.

## Links
- Program (devnet): https://solscan.io/account/C43aRCCQyAw28vCZ4GRTr8yPt7dTc8CbiY26VdZRRcEv?cluster=devnet
- Live app: https://kult-flux.rj838486.workers.dev
- Demo video: TODO
- Source: https://github.com/RonitSDE/kult-fuse

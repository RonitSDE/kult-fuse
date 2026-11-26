# KULT Fuse — PREDICT Prediction Arena

**A community funds a prediction market together, takes opposite views on it, and can check every step on Solana, from the opening price to the payout.**

Built on the [$PREDICT pm-AMM](https://predict-pm-amm.dev/) on Solana devnet. All collateral is test mUSDC.

- Live app: `<public URL>`
- Demo video: `<link>`
- Live scoreboard: `<public URL>/api/predict/stats`

## How it works

1. **Fund.** Participants commit mUSDC to a PREDICT Commitment Vault. Committers become the market's liquidity providers; a commitment is not a YES/NO position.
2. **Launch.** Once the vault reaches its target, anyone can launch it. PREDICT opens the pm-AMM market at the price the committers set.
3. **Trade.** Traders buy YES or NO, and can sell back to the pool any time before expiry, with a test wallet saved in their browser, or with Phantom, Solflare or Backpack. Fuse session limits (one market, a one-hour budget, a slippage cap) are checked before each trade, and PREDICT enforces the signed minimum output on-chain.
4. **Exit or claim.** Liquidity providers can withdraw before resolution (matched YES+NO pairs are redeemed to mUSDC straight away). After the creator resolves the market on-chain, winners claim and LPs claim their pool payout from the same page.

## Why the pm-AMM

YES/NO tokens pay 0 or 1 at expiry, so their risk changes as the deadline approaches. An order book needs market makers quoting every market; a constant-product pool prices a ratio, not a probability; parimutuel pools hide the price until entries close. PREDICT's pm-AMM prices outcomes as probabilities, quotes from the first second, and shrinks liquidity with √(time left) so LP losses arrive evenly rather than all at the end. Commitment Vaults let a community supply that opening liquidity before the market exists.

## Traction you can check

The scoreboard counts only **finalized** devnet PREDICT buys and sells that:

- carry a short-lived Fuse attestation bound to the wallet, market, blockhash, side, action (buy or sell), amount and minimum output;
- contain exactly one PREDICT swap between mUSDC and an outcome token, with token movements matching the attested amount to the unit (mUSDC spent on a buy, outcome tokens sold on a sell). YES↔NO swaps are not counted.

The submission checker verifies the YES and NO buys plus one separately verified sell on the featured market.

Swaps reported before finality are finalized by the server in the background, so a trade counts even if the tab closed. Trades made outside this app don't count.

## Run it

Node 24.

```bash
npm ci && npm --prefix apps/predict ci
npm --prefix apps/predict run build
cp .env.example .env    # set PREDICT_ATTESTATION_KEY (openssl rand -hex 32) and a dedicated devnet RPC
npm start               # http://localhost:8787
npm test
```

Deploy with `render.yaml` or `deploy/Dockerfile`; [docs/PREDICT_V2_WINNING_HANDOFF.md](docs/PREDICT_V2_WINNING_HANDOFF.md) has the full checklist and the demo script.

## Limits, stated plainly

- PREDICT markets resolve manually by their creator; there is no oracle.
- PREDICT has upgrade authority and no third-party audit.
- Fuse session limits are enforced in the browser; PREDICT enforces the minimum output on-chain.
- Devnet test funds only.

## Also in this repo

`/perps/` is a separate research lab: a prediction-market-conditioned SOL-PERP mandate on Velocity. It is not PREDICT traction. See [docs/PERPS_LAB.md](docs/PERPS_LAB.md).

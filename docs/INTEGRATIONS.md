# Integrations

## Polymarket
Default live prediction source (public Gamma + CLOB APIs). Fuse derives a probability mark from the outcome token's best bid/ask and blocks risk increases for stale or excessively wide markets.

## DFlow / Kalshi
Alternative live prediction source (`EVENT_SOURCE=dflow`, requires an API key).

## Solana RPC
Any devnet RPC (public `api.devnet.solana.com` or a provider such as OrbitFlare) for Fuse account state, transaction submission/confirmation and program logs.

## Flash Trade
Primary perp execution adapter for the submission proof. The adapter reconciles actual venue position before and after each absolute target update. The v1 Fuse deployment uses the mature `flash-sdk` devnet path (`devnet.1`) for an auditable open → resize → close chain proof.

## KULT Fuse Anchor
Stores and enforces mandate state: piecewise curve, hard cap, expiry, authorized roles, replay protection, absorbing kill and target validation.

## Generic driver
A fallback integration boundary remains for venue replacement without changing the Fuse engine. It is not used as the headline submission path.

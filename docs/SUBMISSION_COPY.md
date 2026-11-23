# Submission copy · fill proof first

**Name:** KULT Fuse

**Tagline:** Guardrails for AI trading agents. The agent proposes, the mandate decides, Solana enforces it.

**Description:** An owner commits a mandate to Solana: a curve from Kalshi probability to SOL-PERP exposure, a hard cap, a kill line and an expiry. An agent reads the Kalshi market through DFlow and proposes a target. The Fuse program refuses anything off the curve, over the cap, after expiry or after a kill. Only then does the worker trade on Velocity, with bounded immediate-or-cancel orders. Every fill becomes a receipt anchored on-chain, and an independent verifier matches it to Velocity's own fill event. Stale, wide or thin quotes can never add risk.

**Why it matters:** agents are starting to trade on-chain with real money. Today their limits live in a config file the agent can ignore. Fuse puts the limits on-chain and makes every fill provable.

**Limitation to state plainly:** this build's Velocity key is held by the worker, so the worker could trade around Fuse. A Fuse kill is not a venue close; the close is a separate transaction. The signal observation is submitted by the worker. Binding the venue key to a Fuse PDA is the next milestone (docs/BOUND_AUTHORITY.md).

**Evidence required before saying "execution verified":** live DFlow quote on the public URL, Fuse program and mandate account, create/arm/target/kill signatures, three Velocity fill signatures (open, resize, close), close residual, verifier output, build SHA. A simulation is labelled as one. Without those links, say "No execution to verify".

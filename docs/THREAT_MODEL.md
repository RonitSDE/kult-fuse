# Threat model

## Assets

- user collateral/perp position;
- owner/execution/oracle signing keys;
- committed Fuse policy;
- accepted event probability;
- execution/receipt history.

## Primary threats and controls

### Replayed event update
Control: monotonic `oracle_sequence` onchain and in the worker.

### Double execution after RPC timeout or worker crash
Control: actual venue position is authoritative. Reconcile target minus **actual position**, not target minus last local receipt. Deterministic client IDs are used where the venue supports them.

### Threshold oscillation / excessive turnover
Control: probability hysteresis plus N-observation confirmation and minimum rebalance size.

### Manipulated/thin event price
Control: use bid/ask midpoint, maximum spread, maximum signal age; production should add minimum depth/liquidity and optional multi-source sanity checks.

### Stale signal increases risk
Control: stale/wide observations cannot increase exposure.

### Kill state reopens
Control: `KILLED` is absorbing. Onchain target can only be zero/reducing after kill.

### Loss-stop marketed as guaranteed loss cap
Control: terminology says **loss-stop trigger**. Hard invariant is target notional cap; gaps/slippage can exceed the requested loss budget.

### Compromised AI/agent
Control: Agent proposes only. Committed policy, authorities and hard cap govern execution after authorization.

### Compromised execution worker
Control: onchain target cap, allowed Fuse/market context, separate execution authority, replay nonces, operational key limits. A future version should bind venue/instruction verification more tightly onchain.

### Compromised oracle worker
Control: separate oracle authority, freshness/sequence constraints. V1 still trusts this authority for the external prediction-market observation. Production can add quorum/attestation schemes.

### Receipt database tampering
Control: hash-linked receipts with latest hash anchored onchain. Any historical edit breaks verification.

## Known v1 trust boundaries

External prediction-market probability and external perp fills are not made trustless by the Fuse program. The program proves authorization and bounded policy state; it does not cryptographically prove an offchain venue's matching engine.

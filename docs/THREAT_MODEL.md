# Threat model · v1.3

**Trusted parties:** the Polymarket observation is supplied by the oracle worker, the execution worker holds a Drift trading key, and the API operator controls owner keys. If either worker is compromised, it can lie about observations or trade outside Fuse. This release is not a noncustodial authority boundary.

**Program controls on submitted targets:** a committed curve and cap, unique increasing nonces, expiry, fresh observation for increases, absorbing kill. A risk reduction/close can proceed during quote staleness. The program accepts a worker-attested fill amount and receipt hash after the venue transaction; it cannot force the venue close.

**Worker controls:** stale, wide or thin data blocks increases; position is read before/after orders; bounded IOC avoids resting orders; zero fills do not create receipts; kill retries a close while residual exposure remains. An RPC timeout or venue error can still leave an ambiguous or open position; inspect actual venue state before retrying.

**Verification:** a receipt hash chain and last onchain head are necessary but not sufficient. The verifier checks the onchain policy hash, a matching Fuse FillRecorded event for each anchor, a matching Drift fill event for the expected user/market and base delta, and transaction statuses. No decoder, missing receipt, failed anchor or missing account means Unverified. Event logs and receipts should be inspected again after any SDK or program change.

**Loss stop:** policy.example.json leaves it off. If enabled, venue P&L triggers worker kill and a separate close. It is not an onchain P&L invariant or maximum realized loss. Fees, market gaps, outages and slippage may increase realized loss.

**Deployment:** separate owner/oracle/execution/venue keys, restrict signing and withdrawal rights, encrypt backups, keep a persistent data disk, monitor stale quote, failed anchor, kill with residual exposure, nonce failures, unexpected venue orders and RPC failures. An external audit and real authority binding are prerequisites for a serious mainnet product.

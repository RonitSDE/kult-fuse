# Integrations

Polymarket public Gamma/CLOB data supplies the event's YES book. The oracle worker submits a quote observation to Fuse; its honesty remains a trust assumption. Select an event directly related to the traded SOL perp and check spread, age and depth.

Drift SOL-PERP is the preferred venue adapter. It places a bounded IOC limit order, then reconciles actual base exposure. A read-only decoder checks Drift fill events in the venue transaction against receipt delta. Runtime SDK compatibility, liquidity and a funded wallet still need a live integration test.

The Solana/Anchor Fuse program commits the policy and validates submitted target updates. It records a receipt hash after an external fill is reported. It does not hold the Drift key or receive an atomic venue execution guarantee.

Flash Trade and DFlow adapters remain in source for historical work, but are outside this release's judge path. The previous Flash devnet open was blocked by InstructionNotAllowed. Do not present old Fuse-only signatures as venue execution.

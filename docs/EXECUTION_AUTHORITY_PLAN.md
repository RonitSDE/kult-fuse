# Unbound Venue Authority — last major architectural gap

**Current release = policy-verified, worker-signed execution.** Fuse validates each instruction *sent to Fuse*, but the Venue trading key can send direct Velocity orders outside the mandate. Operational leverage checks and API authentication are **not** a replacement for authority binding.

Velocity currently documents per-subaccount delegated trading permissions. A delegate typically cannot withdraw, but may place and modify orders on that subaccount. Delegating to an ordinary worker key reduces custody exposure, **not** the ability to bypass Fuse's position cap.

Recommended technical investigation after establishing a live devnet flow:

1. Confirm, using the exact Velocity SDK and program IDs on the target cluster, whether Velocity accepts a **PDA as a delegated trading signer** in a CPI instruction, including all necessary remaining accounts, order params, fill hooks and reduce-only IOC close.
2. Move the trading delegate authority to a Fuse program PDA with no worker-owned alternative authority. The owner retains withdrawal and revocation authority outside the worker; withdraw/delegate-transfer permissions must remain restricted.
3. Add a Fuse `execute_perp` instruction that authenticates the committed policy, fresh oracle, expiry, nonce, cap and actual current Velocity exposure before CPI; only program-approved orders are sent. Preserve close/reduce-only after kill.
4. Prove attack negatives **at Velocity**: direct order with *every worker-held key* fails over cap and after kill, while approved orders and emergency closes succeed. Run fuzz/invariant tests, interruption recovery and external review.
5. Only then consider marking venue authority as `bound:true` on the dashboard. The v1.8.0 code deliberately leaves this `false`.

References: https://docs.velocity.exchange/protocol/getting-started/delegated-accounts and https://docs.velocity.exchange/developers/velocity-sdk/users. Documentation is not proof the proposed CPI signer pathway is supported by the deployed venue.

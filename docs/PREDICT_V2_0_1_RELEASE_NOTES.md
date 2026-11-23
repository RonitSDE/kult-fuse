# KULT Fuse v2.0.1 — PREDICT official-source compatibility patch

**Reason:** the supplied `pm-amm-main.zip` revealed integration mismatches that would block a genuine sponsor demo. The referenced repository was inspected locally; the original PREDICT program and SDK are **not** shipped as part of KULT Fuse. PREDICT SDK dependency remains pinned at 0.2.0.

## Fixed
- Independent trade verifier now recognizes `global:swap` (IDL discriminator `[248,198,158,145,225,117,135,200]`), not nonexistent `swap_yes_no`.
- Transaction must contain a genuine PREDICT swap whose accounts include the selected market PDA.
- Verified YES/NO balance increase must use outcome mints derived from **that market's exact PREDICT PDA seeds**. Unrelated outcome token activity can no longer count as sponsor traction.
- Browser price/quote calculations follow PREDICT's own `examples/quickstart-devnet/index.cjs` and SDK math. Price is **estimated**, not guaranteed exact; the minimum-output bound is submitted to PREDICT onchain.
- Devnet-only market discovery rejects pools with collateral other than the exact PREDICT mock USDC mint.
- Web-server CSP allows Solana devnet RPC and sponsor faucet connections. Custom HTTPS devnet RPC must be configured consistently for server and frontend.
- Render and Docker no longer call nonexistent `sync:helpers` build script.

## Validation limitations
- Local JS tests, syntax checks and source hashes are independently runnable in this package.
- Official SDK installation, Vite compilation and real devnet PREDICT transactions remain **unverified**. Node 24, a clean dependency installation, a public host, and confirmed vault/market/swap proofs must still come from the deployer.
- `PREDICT_V2_WINNING_HANDOFF.md` gives required developer procedures; ensure contracts and wallet accounts remain devnet-only.
- Owner kill is an **application-level** restriction, not cryptographic delegation of signer authority.

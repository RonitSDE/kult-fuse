# KULT Fuse v1.10.0 — Developer devnet handoff (short)

This is the final **testnet integration candidate**, not a certified live-trading or mainnet build.

1. Install **Node 24**, `npm ci && npm test`; compile Anchor with `anchor build && anchor test` and deploy on **Solana devnet**. Commit generated IDL and program ID.
2. Configure `.env` from `.env.example`: `SOLANA_CLUSTER=devnet`, `VELOCITY_ENV=devnet`, selected DFlow **YES** mint, distinct owner/executor/oracle and Velocity keys, persistent storage, safe operator token, public URL, release tag and SHA. Keep `FUSE_ALLOW_MAINNET_ORDERS` unset. `KALSHI_OBSERVER_ENABLED=1` enables **read-only** comparison; never add Kalshi trading credentials.
3. Run `npm run preflight`, `npm run smoke:dflow`, `npm run venue:setup -- --fund 25` and a dry run of the venue proof. Check Kalshi reference status / DFlow freshness in `/api/market/context`, and decision provenance in `/api/journal`.
4. Execute **real devnet**: mandate create → arm → actual Velocity open fill → resize → onchain over-cap refusal → kill → confirmed Velocity close / zero residual exposure → post-kill refusal. Verify all signatures, fill event decoding, the Fuse anchor and exact mandate ID. Record failures honestly.
5. Deploy the public service and test desktop/mobile, `/healthz`, `/api/state`, `/api/market/context`, `/api/journal`, `/api/proof`; obtain `npm run verify` and `npm run submission:check -- --url https://YOUR-HOST` green on the tagged SHA. Record the video from that release only.

**Critical limitation:** Velocity signing authority still belongs to the worker; a compromised worker can bypass the program. Kill does **not** guarantee venue close. No mainnet with user funds until delegation/control redesign and independent security review.

Send: URL, program ID + IDL, seven proof signatures (create, arm, target, kill, open, resize, close), flat-position evidence, CI link, SHA and 90-second/150-second demo as appropriate.

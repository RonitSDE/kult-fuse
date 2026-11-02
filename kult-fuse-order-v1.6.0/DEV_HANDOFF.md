# KULT Fuse v1.6.0 · final developer handoff

1. Build and test the Anchor 0.31 program, deploy the current schema, commit its matching generated IDL and start a fresh Fuse account. Run `npm ci && npm test && npm run preflight`. Set a real BUILD_SHA and BUILD_TAG on the host.
2. Use an active, liquid SOL-related Polymarket YES market and write its causal link to the SOL perp. Run a small same-cluster Drift open → resize → kill → close on an isolated venue account. Record three venue fill signatures, the four Fuse signatures, anchored receipts and actual close residual. No-fill is an honest failed gate.
3. Run the independent verifier from the tagged release. Keep the live loss stop disabled (`lossStopUsd=0`) unless an actual venue P&L trigger and close are demonstrated. Test over-cap and post-kill program refusal. Disclose that the worker still controls the venue key.
4. Host the public app with a persistent data disk. Film the exact URL in incognito showing a live quote, the decision log, onchain policy, real fills or honest no-fill, and verifier result. Fill the manifest only from observed evidence, run `npm run manifest:source`, then run `sha256sum -c SOURCE_MANIFEST.sha256`, `npm run release:check` and `npm run submission:check -- --url https://YOUR_HOST`.

The full deployment sequence and failure recovery are in [docs/DEPLOY_FINAL.md](docs/DEPLOY_FINAL.md). The archive is source; compilation, funded devnet integration and public video are still required.

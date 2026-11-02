# Local validation · v1.6.0

On 2026-10-30, `npm ci --ignore-scripts --no-audit --no-fund` installed the pinned dependency tree and `npm test` passed 51 deterministic tests, including expiry during a quote outage, concurrent kill versus tick, no-fill proof refusal and expiry close links. `node --check` and `sha256sum -c SOURCE_MANIFEST.sha256` are release gates. The submission gate intentionally fails while SUBMISSION_MANIFEST.json is blank.

This environment has no Rust, Solana CLI, Anchor compiler, funded venue key, public deployment or matching generated IDL. It cannot prove Anchor build/test, live Polymarket delivery, Drift order execution, onchain receipt anchoring, public URL, mobile browser behavior or bound trading authority. The developer must execute and record those gates from the final tagged release. Passing mocked tests does not establish hackathon readiness.

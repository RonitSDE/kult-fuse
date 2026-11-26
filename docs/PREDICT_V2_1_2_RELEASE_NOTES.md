# KULT Fuse v2.1.2 — review fixes on the deployed main branch

Built on the deployed `kult-fuse-main` (v2.1.1 plus the developer's external wallets, market discovery and live hero). All of the developer's features are kept.

1. **Phantom trades could fail attestation.** Phantom may add Lighthouse assertion instructions to transactions it signs. The attestation verifier rejected any top-level program outside PREDICT, Memo, ComputeBudget and associated-token creates, so such a trade landed on-chain but never counted. Lighthouse (`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`, immutable, assertion-only) is now allowed. The token-delta checks still require exactly the attested spend and outcome gain. Two tests cover this: Phantom-style extras pass, and any other program still fails.
2. **Market odds bars were blocked by CSP.** The new market rows set `style="width:…%"` inside `innerHTML`, which `style-src 'self'` blocks. Widths are now set through the DOM after rendering.
3. **Hero headline words ran together.** A fixed −6px letter-spacing on the 92px headline ate the word spaces ("Launchamarket."). Tracking is now relative to size (−0.04em) with slight word spacing, on desktop and phone.
4. **Repository cleanup for judges.**
   - Removed v1.6 handoff docs (`BUILD_REPORT.md`, `DEV_HANDOFF.md`, `FINAL_VALIDATION.md`) that described a Polymarket/Drift product.
   - Removed retired Drift and Flash adapters, scripts and their test; nothing imported them.
   - The root README is now one PREDICT-first story; the perps lab moved to `docs/PERPS_LAB.md`.
   - `SUBMISSION_MANIFEST.json` no longer describes a tab-scoped wallet.

**Verified here:** 154 tests pass (the two new verifier tests added, the two retired Drift tests removed) and the app builds. In a real browser under the live CSP, the inline width was blocked and the DOM-set width rendered, and the wallet menu opens. **Not verified:** a live Phantom/Solflare/Backpack devnet trade. Do one of each before recording.

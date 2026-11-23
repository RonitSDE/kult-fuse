# KULT Fuse v2.1.1 — traction fixes

Built on v2.1.0. The attestation and finality rules are unchanged; these fixes make sure real trades are counted and traders can come back.

1. **The test wallet persists in the browser.** v2.1.0 kept it in tab-only storage, so closing the tab lost the test funds, open positions and any claim after resolution. It also counted one person as several wallets, made repeat traders nearly impossible, and burned the faucet's five claims a day per IP. The wallet now lives in `localStorage`; v2.0.x and v2.1.0 wallets carry over automatically. `apps/predict/src/wallet.js`.
2. **Trades count even if the tab closes before finality.** v2.1.0 recorded a swap only when the browser polled again after finality (about 15–30 s). The server now queues every swap reported as confirmed or pending on disk (`predict-receipts.json.pending.json`) and finalizes it in the background every `PREDICT_RECONCILE_MS` (10 s). The queue survives restarts, drops failed swaps, and expires entries after 15 minutes (500 max). `/api/predict/stats` reports `pendingFinality`.
3. **Simultaneous traders aren't turned away.** v2.1.0 allowed one verify and one attest request in flight for all visitors, and ran every verification's RPC lookups inside its single write queue. A refused attestation blocks the trade. Now:
   - verify allows 6 in flight and 600 a minute;
   - attest (HMAC only, no RPC) allows 16 in flight and 600 a minute;
   - RPC work runs outside the write queue, and only read-check-write is serialized;
   - browser polls for a queued swap are answered from its last check for 4 s.
   
   Ten simultaneous attest requests all returned 200 in a local run.

**Config:** set `PREDICT_ATTESTATION_KEY` by hand (`openssl rand -hex 32`). Render's generated values aren't hex. Without the key, trades can't be attested.

**Verified here:** 152 tests pass (4 new). The app installs, checks and builds. The server answers stats, attest and health. A real browser keeps the same wallet after its tab is closed and a new one opened.

**Not verified:** a live Devnet trade and its background finalization. Do one full trade on the deployed URL, close the tab right after confirmation, and check that it appears on the scoreboard within a minute.

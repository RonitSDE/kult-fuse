// Watches the selected Kalshi market through DFlow until the book moves (that proves the feed is
// live), then grades the quote against the policy.
//   npm run smoke:dflow                 waits up to 5 minutes
//   SMOKE_WAIT_SEC=900 npm run smoke:dflow
import fs from 'node:fs';
import { DFlowEventSource } from '../src/adapters/event/dflow-event.mjs';
import { makeProbabilityMark } from '../src/core/probability.mjs';

const policy = JSON.parse(fs.readFileSync(process.env.POLICY_FILE || './policy.example.json', 'utf8'));
const source = new DFlowEventSource({ baseUrl: process.env.DFLOW_BASE_URL, apiKey: process.env.DFLOW_API_KEY, marketMint: process.env.DFLOW_MARKET_MINT, sizeDecimals: process.env.DFLOW_SIZE_DECIMALS, maxIdleSec: process.env.DFLOW_MAX_BOOK_IDLE_SEC });
const info = await source.init();
console.log(`${info.ticker}: ${info.question}`);
if (info.endDateMs && info.endDateMs < Date.now() + 24 * 3600_000) console.warn('warning: this market closes within 24h; the mandate cannot outlive it');
const deadline = Date.now() + Number(process.env.SMOKE_WAIT_SEC || 300) * 1000;
let raw;
do {
  raw = await source.read();
  const mark = makeProbabilityMark(raw, policy);
  console.log(`${new Date().toISOString().slice(11, 19)}  seq ${raw.sequence ?? '-'}  ${(mark.probability * 100).toFixed(1)}%  spread ${mark.spreadBps} bps  depth ${mark.depthUsd == null ? 'n/a' : `$${mark.depthUsd.toFixed(0)}`}  ${raw.freshnessBasis}`);
  if (raw.freshnessProven) break;
  await new Promise((r) => setTimeout(r, 5000));
} while (Date.now() < deadline);
const mark = makeProbabilityMark(raw, policy);
if (!raw.freshnessProven) { console.error('The book never moved in the window. Pick a more active market or wait longer (SMOKE_WAIT_SEC).'); process.exit(1); }
if (!mark.quality) { console.error(`Quote fails policy quality (${mark.qualityReason}): spread ${mark.spreadBps}/${policy.maxSpreadBps} bps, depth ${mark.depthUsd ?? 'n/a'}/${policy.minTopDepthUsd} USD`); process.exit(1); }
console.log('DFLOW SMOKE PASS: live, tight and deep enough to trade on');

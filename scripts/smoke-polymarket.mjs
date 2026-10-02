import fs from 'node:fs';
import { DEFAULT_POLYMARKET_MARKET, PolymarketEventSource } from '../src/adapters/event/polymarket-event.mjs';
import { makeProbabilityMark } from '../src/core/probability.mjs';

const policy = JSON.parse(fs.readFileSync(process.env.POLICY_FILE || './policy.example.json', 'utf8'));
const source = new PolymarketEventSource({ market: process.env.POLYMARKET_MARKET || DEFAULT_POLYMARKET_MARKET, outcome: process.env.POLYMARKET_OUTCOME || 'Yes', gammaUrl: process.env.POLYMARKET_GAMMA_URL, clobUrl: process.env.POLYMARKET_CLOB_URL });
const info = await source.init();
const raw = await source.read();
const mark = makeProbabilityMark(raw, policy);
console.log(JSON.stringify({ market: info, bid: raw.bid, ask: raw.ask, probabilityBps: mark.pBps, spreadBps: mark.spreadBps, quality: mark.qualityReason }, null, 2));
if (!mark.quality) { console.error(`Market quote fails policy quality (${mark.qualityReason}); spread ${mark.spreadBps} bps > maxSpreadBps ${policy.maxSpreadBps}?`); process.exit(1); }
console.log('POLYMARKET SMOKE PASS');

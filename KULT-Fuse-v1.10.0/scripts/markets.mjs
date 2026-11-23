// Lists active Kalshi markets on DFlow so you can pick DFLOW_MARKET_MINT (the YES mint).
//   npm run markets                       SOL series by default
//   npm run markets -- --series KXBTCD    any Kalshi series ticker(s), comma separated
//   npm run markets -- --search solana    match words in event or market titles
import { DFLOW_DEV_URL, DFLOW_PROD_URL } from '../src/adapters/event/dflow-event.mjs';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const series = arg('series') || 'KXSOLD,KXSOL,KXSOLMAXY,KXSOLMINY';
const search = (arg('search') || '').toLowerCase();
const key = process.env.DFLOW_API_KEY || '';
const base = (process.env.DFLOW_BASE_URL || (key ? DFLOW_PROD_URL : DFLOW_DEV_URL)).replace(/\/$/, '');
const url = `${base}/api/v1/events?withNestedMarkets=true&status=active&limit=100&seriesTickers=${encodeURIComponent(series)}`;

const res = await fetch(url, { headers: { accept: 'application/json', ...(key ? { 'x-api-key': key } : {}) } }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
if (!res.ok) { console.error(`DFlow ${res.status}: ${(await res.text()).slice(0, 200)}`); process.exit(1); }
const { events = [] } = await res.json();
const rows = [];
for (const ev of events) {
  for (const m of ev.markets || []) {
    const text = `${ev.title} ${m.title} ${m.yesSubTitle || ''}`.toLowerCase();
    if (search && !text.includes(search)) continue;
    const acct = Object.values(m.accounts || {})[0] || {};
    rows.push({ ticker: m.ticker, title: m.yesSubTitle || m.title || ev.title, closes: m.closeTime ? new Date(m.closeTime * 1000).toISOString().replace('.000Z', 'Z') : '?', bid: m.yesBid ?? '-', ask: m.yesAsk ?? '-', yesMint: acct.yesMint || '(not tokenized yet)' });
  }
}
if (!rows.length) { console.log(`No active markets for ${series}${search ? ` matching "${search}"` : ''}. Try --series or --search.`); process.exit(0); }
rows.sort((a, b) => a.closes.localeCompare(b.closes));
for (const r of rows) console.log(`${r.ticker}\n  ${r.title} · closes ${r.closes} · YES ${r.bid}/${r.ask}\n  DFLOW_MARKET_MINT=${r.yesMint}`);
console.log(`\n${rows.length} market(s). Pick one whose YES outcome implies a SOL long, with a close time after your demo.`);

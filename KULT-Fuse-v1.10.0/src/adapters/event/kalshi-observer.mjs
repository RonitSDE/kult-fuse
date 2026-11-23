/**
 * Kalshi public market observer. INFORMATIONAL ONLY: no keys, orders or mandate input.
 * DFlow (Solana outcome mint) remains the sole trading signal.
 * Official endpoints: GET /markets/{ticker}, /markets/{ticker}/orderbook.
 */
export const KALSHI_PUBLIC_PROD = 'https://external-api.kalshi.com/trade-api/v2';
export const KALSHI_PUBLIC_DEMO = 'https://external-api.demo.kalshi.co/trade-api/v2';
export function validKalshiTicker(ticker) {
  return typeof ticker === 'string' && /^[A-Z0-9][A-Z0-9_-]{1,119}$/.test(ticker);
}
const num = (v) => { if (v === undefined || v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
function dollars(v) {
  const n = num(v);
  return n != null && n >= 0 && n <= 1 ? n : null;
}
function cents(v) { const n = num(v); return n != null && n >= 0 && n <= 100 ? n / 100 : null; }
function best(levels) {
  if (!Array.isArray(levels)) return null;
  return levels.map(([p,s])=>({p:dollars(p),s:num(s)}))
    .filter(x=>x.p !== null && x.s !== null && x.s>0)
    .sort((a,b)=>b.p-a.p)[0] || null;
}
/** FIXED-POINT latest response: orderbook_fp.{yes_dollars,no_dollars} */
export function kalshiBookSummary(json) {
  const yes = best(json?.orderbook_fp?.yes_dollars);
  const no = best(json?.orderbook_fp?.no_dollars);
  if (!yes || !no) return { status:'EMPTY_BOOK', bid:null, ask:null, midpoint:null, spreadBps:null, depthUsd:null };
  const bid = yes.p, ask = 1-no.p;
  if (ask < bid) return { status:'CROSSED_BOOK', bid, ask, midpoint:null, spreadBps:null, depthUsd:null };
  return { status:'OBSERVED', bid, ask, midpoint:(bid+ask)/2,
    spreadBps:Math.round((ask-bid)*10000), depthUsd:Math.min(yes.s*bid,no.s*ask) };
}
function priceFromMarket(m) {
  const bid = dollars(m.yes_bid_dollars) ?? cents(m.yes_bid);
  const ask = dollars(m.yes_ask_dollars) ?? cents(m.yes_ask);
  return { bid, ask };
}
export function compareKalshiToDflow(kalshi, dflowQuote, maxDifferenceBps=1000) {
  if (kalshi?.status !== 'OBSERVED') return { status:'NOT_COMPARABLE', differenceBps:null };
  const dflow = num(dflowQuote?.probability);
  if (dflow === null || dflow < 0 || dflow > 1) return { status:'NO_DFLOW_QUOTE', differenceBps:null };
  const differenceBps = Math.round(Math.abs(kalshi.midpoint - dflow) * 10000);
  return { status:differenceBps > maxDifferenceBps ? 'DIVERGENT' : 'SIMILAR', differenceBps };
}
export class KalshiPublicObserver {
  constructor({ environment='production', enabled=true, timeoutMs=4000, ttlMs=30000, fetchImpl=fetch, now=Date.now }={}) {
    this.base = environment === 'demo' ? KALSHI_PUBLIC_DEMO : KALSHI_PUBLIC_PROD;
    this.environment = environment === 'demo' ? 'demo' : 'production';
    this.enabled = enabled;
    this.timeoutMs=timeoutMs; this.ttlMs=ttlMs; this.fetch=fetchImpl; this.now=now;
    this.cache=null; this.inflight=null;
  }
  async get(pathname) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try {
      const resp=await this.fetch(`${this.base}${pathname}`, { headers:{ accept:'application/json' }, signal:controller.signal });
      if(!resp.ok) throw new Error(`Kalshi HTTP ${resp.status}`);
      // Cap upstream body so a compromised response cannot consume arbitrary memory.
      if(Number(resp.headers?.get?.('content-length')||0)>128000) throw new Error('Kalshi response too large');
      const body=await resp.text();
      if(body.length>128000) throw new Error('Kalshi response too large');
      return JSON.parse(body);
    } finally { clearTimeout(timer); }
  }
  async read(ticker, dflowQuote) {
    const base={ source:'KALSHI_PUBLIC_REST', environment:this.environment, role:'REFERENCE_ONLY_NOT_AN_EXECUTION_ORACLE', at:new Date(this.now()).toISOString() };
    if(!this.enabled) return { ...base, status:'DISABLED', comparison:{status:'NOT_COMPARABLE',differenceBps:null} };
    if(!validKalshiTicker(ticker)) return { ...base, status:'NO_MATCHED_TICKER', comparison:{status:'NOT_COMPARABLE',differenceBps:null} };
    // Cache raw observations only; comparison uses the current DFlow quote each time.
    if(!this.cache || this.cache.ticker!==ticker || this.now()-this.cache.at>=this.ttlMs) {
      if(!this.inflight) this.inflight=this.fetchAndCache(ticker).finally(()=>{this.inflight=null;});
      await this.inflight;
    }
    const data=this.cache?.data;
    if(!data) return {...base, ticker, status:'UNAVAILABLE', reason:'No public Kalshi data available', comparison:{status:'NOT_COMPARABLE',differenceBps:null}};
    const refStatus=String(data.marketStatus||'').toLowerCase();
    const comparison=['closed','settled','finalized','halted','determined'].includes(refStatus)
      ? {status:'MARKET_NOT_OPEN',differenceBps:null}
      : compareKalshiToDflow(data.orderbook,dflowQuote);
    return {...base, ...data, comparison };
  }
  async fetchAndCache(ticker) {
    let data;
    try {
      const [marketPayload,bookPayload]=await Promise.all([this.get(`/markets/${encodeURIComponent(ticker)}`),this.get(`/markets/${encodeURIComponent(ticker)}/orderbook`)]);
      const m=marketPayload?.market;
      if(!m || m.ticker!==ticker) throw new Error('Kalshi ticker mismatch');
      const orderbook=kalshiBookSummary(bookPayload);
      data={status:'OBSERVED', ticker, title:m.title || null, eventTicker:m.event_ticker || null,
        marketStatus:m.status || 'unknown', closeTime:m.close_time || null,
        settlementSource:m.rules_primary || null, // text only, no interpretation as approved oracle
        indicative:priceFromMarket(m), orderbook,
        quoteTime:new Date(this.now()).toISOString(),
        advisory:'Kalshi REST is cached and may lag. DFlow remains the sole Fuse trading input.'};
    } catch (error) {
      data={status:'UNAVAILABLE', ticker, reason:String(error?.message||'Kalshi query failed').slice(0,140)};
    }
    this.cache={ticker,at:this.now(),data};
  }
}

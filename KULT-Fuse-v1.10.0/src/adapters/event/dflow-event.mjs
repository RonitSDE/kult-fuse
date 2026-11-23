/**
 * DFlow prediction-market adapter: Kalshi markets tokenized on Solana as SPL outcome mints.
 *
 * Metadata: GET /api/v1/market/by-mint/{mint}           title, ticker, closeTime, status, yesBid/yesAsk
 * Book:     GET /api/v1/orderbook/by-mint/{mint}        { sequence, yes_bids: {price: size}, no_bids: {...} }
 *
 * A YES ask is the complement of the best NO bid (buying YES at a crosses a NO bid at 1 - a).
 * Top-of-book depth is size × price in USD, with sizes in contracts ($1 notional at settlement).
 * When the book is empty or unavailable the market's yesBid/yesAsk are used with no depth, so a
 * policy with minTopDepthUsd > 0 treats the quote as THIN and refuses risk increases.
 *
 * Dev host (no key): https://dev-prediction-markets-api.dflow.net
 * Production host:   https://prediction-markets-api.dflow.net (x-api-key)
 */
export const DFLOW_DEV_URL = 'https://dev-prediction-markets-api.dflow.net';
export const DFLOW_PROD_URL = 'https://prediction-markets-api.dflow.net';

const toProb = (v) => {
  if (v == null || v === '') return null;
  let n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 1) n /= 100; // cents
  return n >= 0 && n <= 1 ? n : null;
};

export function bestOf(levels = {}) {
  let best = null;
  for (const [price, size] of Object.entries(levels || {})) {
    const p = toProb(price);
    const s = Number(size);
    if (p == null || !(s > 0)) continue;
    if (!best || p > best.price) best = { price: p, size: s };
  }
  return best;
}

/** Book → { bid, ask, bidDepthUsd, askDepthUsd } for the YES outcome, or null if one side is empty. */
export function yesQuoteFromBook(book, { sizeDecimals = 0 } = {}) {
  const scale = 10 ** sizeDecimals;
  const yesBid = bestOf(book?.yes_bids ?? book?.yesBids);
  const noBid = bestOf(book?.no_bids ?? book?.noBids);
  if (!yesBid || !noBid) return null;
  const ask = Number((1 - noBid.price).toFixed(6));
  if (ask < yesBid.price) return null; // crossed or corrupt book
  return {
    bid: yesBid.price,
    ask,
    bidDepthUsd: (yesBid.size / scale) * yesBid.price,
    askDepthUsd: (noBid.size / scale) * ask
  };
}

export class DFlowEventSource {
  constructor({ baseUrl, apiKey, marketMint, sizeDecimals = 0, maxIdleSec = 900, timeoutMs = 5000, fetchImpl = fetch }) {
    if (!marketMint) throw new Error('DFLOW_MARKET_MINT is required: run `npm run markets` to pick one');
    this.apiKey = apiKey || '';
    this.baseUrl = (baseUrl || (this.apiKey ? DFLOW_PROD_URL : DFLOW_DEV_URL)).replace(/\/$/, '');
    this.marketMint = marketMint;
    this.sizeDecimals = Number(sizeDecimals) || 0;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.lastBookSequence = null;
    this.lastBookReceivedAtMs = null;
    this.hasObservedAdvance = false;
    this.lastAdvanceAtMs = null;
    this.maxIdleSec = Number(maxIdleSec) > 0 ? Number(maxIdleSec) : 900;
    this.info = null;
  }

  async getJson(pathname) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { accept: 'application/json', ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}) };
      const res = await this.fetch(`${this.baseUrl}${pathname}`, { headers, signal: controller.signal });
      if (!res.ok) throw new Error(`DFlow ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async market() {
    return this.getJson(`/api/v1/market/by-mint/${encodeURIComponent(this.marketMint)}`);
  }

  async init() {
    const m = await this.market();
    const closeSec = Number(m.closeTime || m.expirationTime || 0);
    const status = String(m.status || '').toLowerCase();
    if (['closed', 'settled', 'finalized', 'determined'].includes(status)) throw new Error(`DFlow market ${m.ticker || this.marketMint} is ${status}`);
    // A mint can be the YES or the NO side of its market; Fuse's curve is written for YES.
    const accounts = Object.values(m.accounts || {});
    const side = accounts.some((a) => a?.noMint === this.marketMint) ? 'NO' : 'YES';
    if (side !== 'YES') throw new Error(`DFLOW_MARKET_MINT ${this.marketMint} is the NO mint of ${m.ticker}; use its YES mint`);
    this.info = {
      ticker: m.ticker || null,
      eventTicker: m.eventTicker || null,
      question: [m.title, m.yesSubTitle].filter(Boolean).join(' — ') || m.ticker || this.marketMint,
      outcome: 'YES',
      endDateMs: closeSec > 0 ? closeSec * 1000 : null,
      status: status || null,
      rules: m.rulesPrimary || null
    };
    return this.info;
  }

  /**
   * Freshness model (v1.9):
   * - Replay protection: the upstream book `sequence`. It must never go backwards, and an
   *   unchanged sequence carries no new information (the engine holds; nothing goes on-chain).
   * - Liveness: the feed is trusted only after this process has seen the sequence advance, and
   *   only while the last advance is within `maxIdleSec`. A frozen or cached API fails closed.
   * - Age: a book fetched now whose sequence is current *is* the current book, so its age is the
   *   fetch time. (v1.8 aged it from the last change, which made every quiet-but-live Kalshi book
   *   "stale" after 20 s and blocked trading on normal markets.)
   * - No sequence, metadata fallback or a sequence that went backwards: display only.
   */
  async read() {
    if (!this.info) await this.init();
    let quote = null;
    let sequence = null;
    let basis = 'UNVERIFIED_MARKET_FALLBACK';
    const fetchedAtMs = Date.now();
    try {
      const book = await this.getJson(`/api/v1/orderbook/by-mint/${encodeURIComponent(this.marketMint)}`);
      quote = yesQuoteFromBook(book, { sizeDecimals: this.sizeDecimals });
      const rawSequence = book?.sequence;
      const parsed = Number(rawSequence);
      if (quote && rawSequence != null && rawSequence !== '' && Number.isSafeInteger(parsed) && parsed > 0) {
        if (this.lastBookSequence === null) {
          this.lastBookSequence = parsed; // baseline: age unknown until the book is seen to move
          basis = 'AWAITING_FIRST_BOOK_UPDATE';
        } else if (parsed > this.lastBookSequence) {
          this.lastBookSequence = parsed;
          this.lastAdvanceAtMs = fetchedAtMs;
          this.hasObservedAdvance = true;
          basis = 'BOOK_SEQUENCE_ADVANCED';
        } else if (parsed === this.lastBookSequence) {
          basis = 'BOOK_SEQUENCE_UNCHANGED';
        } else {
          // Upstream reset or a replayed snapshot: re-baseline and distrust until it moves again.
          this.lastBookSequence = parsed;
          this.hasObservedAdvance = false;
          basis = 'BOOK_SEQUENCE_WENT_BACKWARDS';
        }
        sequence = parsed;
      }
    } catch { /* fall back to market metadata below: display only */ }
    if (!quote) {
      const m = await this.market();
      const bid = toProb(m.yesBid);
      const ask = toProb(m.yesAsk);
      if (bid == null || ask == null) throw new Error(`DFlow market ${this.info.ticker || this.marketMint} has no YES bid/ask`);
      quote = { bid, ask, bidDepthUsd: null, askDepthUsd: null };
      sequence = null;
      basis = 'UNVERIFIED_MARKET_FALLBACK';
    }
    const live = this.hasObservedAdvance && fetchedAtMs - (this.lastAdvanceAtMs || 0) <= this.maxIdleSec * 1000;
    const trusted = sequence !== null && live && (basis === 'BOOK_SEQUENCE_ADVANCED' || basis === 'BOOK_SEQUENCE_UNCHANGED');
    return {
      ...quote,
      observedAtMs: trusted ? fetchedAtMs : null,
      sequence,
      bookSequence: sequence,
      sequenceAdvanced: basis === 'BOOK_SEQUENCE_ADVANCED',
      lastAdvanceAtMs: this.lastAdvanceAtMs || null,
      freshnessProven: trusted,
      freshnessBasis: sequence !== null && !live && this.hasObservedAdvance ? 'BOOK_IDLE_TOO_LONG' : basis,
      source: `dflow:${this.info.ticker || this.marketMint}`
    };
  }
}

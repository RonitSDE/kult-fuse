/**
 * Polymarket prediction-market adapter (public, no API key).
 * Market metadata: Gamma API  GET /markets?slug=<slug>
 * Live quotes:     CLOB API   GET /book?token_id=<outcome token>
 * Probability = the outcome token's best bid/ask on the live order book.
 *
 * Change this slug to point the mandate at a different open market.
 * https://polymarket.com/event/what-price-will-bitcoin-hit-before-2027
 */
export const DEFAULT_POLYMARKET_MARKET = 'will-bitcoin-reach-95000-by-december-31-2026-from-june-8';

export class PolymarketEventSource {
  constructor({ market, outcome = 'Yes', gammaUrl, clobUrl, timeoutMs = 5000, fetchImpl = fetch }) {
    this.market = market || DEFAULT_POLYMARKET_MARKET;
    this.outcome = outcome;
    this.gammaUrl = (gammaUrl || 'https://gamma-api.polymarket.com').replace(/\/$/, '');
    this.clobUrl = (clobUrl || 'https://clob.polymarket.com').replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.sequence = 0;
    this.info = null;
  }

  async getJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`Polymarket ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async init() {
    const list = await this.getJson(`${this.gammaUrl}/markets?slug=${encodeURIComponent(this.market)}`);
    const m = Array.isArray(list) ? list[0] : list;
    if (!m) throw new Error(`Polymarket market not found: ${this.market}`);
    if (m.closed) throw new Error(`Polymarket market is closed: ${this.market}`);
    // Gamma returns these arrays JSON-encoded as strings.
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
    const outcomes = parse(m.outcomes);
    const tokens = parse(m.clobTokenIds);
    const idx = outcomes.findIndex((o) => String(o).toLowerCase() === String(this.outcome).toLowerCase());
    if (idx < 0 || !tokens[idx]) throw new Error(`Polymarket outcome "${this.outcome}" not found in ${this.market} (${outcomes.join('/')})`);
    this.info = {
      slug: m.slug,
      question: m.question,
      outcome: outcomes[idx],
      tokenId: String(tokens[idx]),
      endDateMs: m.endDate ? Date.parse(m.endDate) : null,
      url: `https://polymarket.com/market/${m.slug}`
    };
    return this.info;
  }

  async read() {
    if (!this.info) await this.init();
    const book = await this.getJson(`${this.clobUrl}/book?token_id=${encodeURIComponent(this.info.tokenId)}`);
    const prices = (side) => (book[side] || []).map((l) => Number(l.price)).filter((p) => Number.isFinite(p));
    const bids = prices('bids');
    const asks = prices('asks');
    if (!bids.length || !asks.length) throw new Error(`Polymarket book for ${this.info.slug} has no ${!bids.length ? 'bids' : 'asks'}`);
    this.sequence += 1;
    return {
      bid: Math.max(...bids),
      ask: Math.min(...asks),
      observedAtMs: Date.now(),
      sequence: this.sequence,
      source: `polymarket:${this.info.slug}`
    };
  }
}

/**
 * Polymarket prediction-market adapter (public, no API key).
 * Market metadata: Gamma API  GET /markets?slug=<slug>
 * Live quotes:     CLOB API   GET /book?token_id=<outcome token>
 * Probability = the outcome token's best bid/ask on the live order book.
 *
 * The selected event must be explicit for the live mandate.
 */
export class PolymarketEventSource {
  constructor({ market, outcome = 'Yes', gammaUrl, clobUrl, timeoutMs = 5000, fetchImpl = fetch }) {
    if (!market) throw new Error('Polymarket event slug is required');
    this.market = market;
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
    const levels = (side) => (book[side] || []).map((l) => ({ price: Number(l.price), size: Number(l.size) })).filter((l) => Number.isFinite(l.price));
    const bids = levels('bids');
    const asks = levels('asks');
    if (!bids.length || !asks.length) throw new Error(`Polymarket book for ${this.info.slug} has no ${!bids.length ? 'bids' : 'asks'}`);
    const bid = Math.max(...bids.map((l) => l.price));
    const ask = Math.min(...asks.map((l) => l.price));
    // USD resting at the best level on each side; a thin top of book is not a usable signal.
    const depth = (ls, px) => ls.filter((l) => l.price === px).reduce((sum, l) => sum + (Number.isFinite(l.size) ? l.size * l.price : 0), 0);
    this.sequence += 1;
    return {
      bid,
      ask,
      bidDepthUsd: depth(bids, bid),
      askDepthUsd: depth(asks, ask),
      // The CLOB stamps each book snapshot; age is measured from that, not from when we fetched it.
      observedAtMs: Number(book.timestamp) > 0 ? Number(book.timestamp) : Date.now(),
      sequence: this.sequence,
      source: `polymarket:${this.info.slug}`
    };
  }
}

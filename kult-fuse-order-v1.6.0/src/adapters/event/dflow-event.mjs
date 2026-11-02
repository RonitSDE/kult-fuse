/**
 * DFlow prediction-market adapter.
 * Uses the official market-by-mint metadata endpoint, which exposes yesBid/yesAsk.
 * Production host: https://prediction-markets-api.dflow.net
 * Dev host: https://dev-prediction-markets-api.dflow.net
 */
export class DFlowEventSource {
  constructor({ baseUrl, apiKey, marketMint, timeoutMs = 5000 }) {
    if (!marketMint) throw new Error('DFLOW_MARKET_MINT is required');
    this.baseUrl = (baseUrl || 'https://prediction-markets-api.dflow.net').replace(/\/$/, '');
    this.apiKey = apiKey || '';
    this.marketMint = marketMint;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
  }

  async read() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = this.apiKey ? { 'x-api-key': this.apiKey } : {};
      const url = `${this.baseUrl}/api/v1/market/by-mint/${encodeURIComponent(this.marketMint)}`;
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) throw new Error(`DFlow ${res.status}: ${await res.text()}`);
      const market = await res.json();
      const yesBidRaw = market.yesBid;
      const yesAskRaw = market.yesAsk;
      if (yesBidRaw == null || yesAskRaw == null) throw new Error('DFlow market missing yesBid/yesAsk');

      // DFlow/Kalshi metadata may encode prices as decimal strings (0..1) or cents (0..100).
      const normalize = (v) => {
        let n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`invalid DFlow price ${v}`);
        if (n > 1) n /= 100;
        return n;
      };

      this.sequence += 1;
      return {
        bid: normalize(yesBidRaw),
        ask: normalize(yesAskRaw),
        observedAtMs: Date.now(),
        sequence: this.sequence,
        source: `dflow:${market.ticker || this.marketMint}`,
        market
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

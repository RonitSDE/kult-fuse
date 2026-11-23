/**
 * Production escape hatch: use any audited venue service implementing this narrow contract.
 * GET  /position?symbol=SOL-PERP -> { exposureUsd, markPrice, unrealizedPnlUsd, venueRef? }
 * POST /target { symbol, targetUsd, clientOrderId, reduceOnly? } -> { txSignature, venueRef, exposureUsd, markPrice }
 */
export class DriverPerpAdapter {
  constructor({ baseUrl, token, symbol = 'SOL-PERP' }) {
    if (!baseUrl) throw new Error('PERP_DRIVER_URL required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.symbol = symbol;
  }
  headers() { return { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }; }
  async getPosition() {
    const res = await fetch(`${this.baseUrl}/position?symbol=${encodeURIComponent(this.symbol)}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`perp driver position ${res.status}: ${await res.text()}`);
    return res.json();
  }
  async executeTarget(targetUsd, { clientOrderId, reduceOnly = false } = {}) {
    const before = await this.getPosition();
    const res = await fetch(`${this.baseUrl}/target`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ symbol: this.symbol, targetUsd, clientOrderId, reduceOnly })
    });
    if (!res.ok) throw new Error(`perp driver target ${res.status}: ${await res.text()}`);
    const out = await res.json();
    const after = await this.getPosition();
    return { ok: true, before, after, deltaUsd: after.exposureUsd - before.exposureUsd, ...out };
  }
}

import crypto from 'node:crypto';

export class PaperPerpAdapter {
  constructor({ symbol = 'SOL-PERP', initialPrice = 150, feeBps = 6, slippageBps = 3 } = {}) {
    this.symbol = symbol;
    this.positionUsd = 0;
    this.markPrice = initialPrice;
    this.avgEntryPrice = 0;
    this.realizedPnlUsd = 0;
    this.feesUsd = 0;
    this.feeBps = feeBps;
    this.slippageBps = slippageBps;
    this.executedClientIds = new Map();
  }
  setMarkPrice(px) { this.markPrice = Number(px); }
  async getPosition() {
    const unrealizedPnlUsd = this.positionUsd === 0 || this.avgEntryPrice === 0
      ? 0
      : this.positionUsd * ((this.markPrice - this.avgEntryPrice) / this.avgEntryPrice);
    return {
      venue: 'PAPER', symbol: this.symbol, exposureUsd: this.positionUsd,
      markPrice: this.markPrice, avgEntryPrice: this.avgEntryPrice,
      unrealizedPnlUsd, realizedPnlUsd: this.realizedPnlUsd, feesUsd: this.feesUsd
    };
  }
  async executeTarget(targetUsd, { clientOrderId } = {}) {
    if (clientOrderId && this.executedClientIds.has(clientOrderId)) return this.executedClientIds.get(clientOrderId);
    const before = await this.getPosition();
    const deltaUsd = Number(targetUsd) - before.exposureUsd;
    if (Math.abs(deltaUsd) < 1e-9) {
      const noop = { ok: true, duplicate: false, txSignature: null, venueRef: null, before, after: before, deltaUsd: 0, feeUsd: 0 };
      if (clientOrderId) this.executedClientIds.set(clientOrderId, noop);
      return noop;
    }

    const direction = Math.sign(deltaUsd);
    const execPrice = this.markPrice * (1 + direction * this.slippageBps / 10000);
    const feeUsd = Math.abs(deltaUsd) * this.feeBps / 10000;

    // Realize PnL on reduction/flip. This is intentionally approximate for deterministic demo mode.
    if (this.positionUsd !== 0 && Math.sign(this.positionUsd) === -Math.sign(deltaUsd)) {
      const closedUsd = Math.min(Math.abs(deltaUsd), Math.abs(this.positionUsd));
      const positionSign = Math.sign(this.positionUsd);
      this.realizedPnlUsd += positionSign * closedUsd * ((execPrice - this.avgEntryPrice) / this.avgEntryPrice);
    }

    const old = this.positionUsd;
    const next = Number(targetUsd);
    if (next === 0) this.avgEntryPrice = 0;
    else if (old === 0 || Math.sign(old) !== Math.sign(next) || Math.abs(next) > Math.abs(old)) {
      const existingWeight = old === 0 || Math.sign(old) !== Math.sign(next) ? 0 : Math.abs(old);
      const addWeight = Math.abs(next - old);
      this.avgEntryPrice = existingWeight + addWeight > 0
        ? ((this.avgEntryPrice * existingWeight) + (execPrice * addWeight)) / (existingWeight + addWeight)
        : execPrice;
    }

    this.positionUsd = next;
    this.feesUsd += feeUsd;
    const after = await this.getPosition();
    const txSignature = `paper_${crypto.randomBytes(12).toString('hex')}`;
    const result = { ok: true, duplicate: false, txSignature, venueRef: clientOrderId || txSignature, before, after, deltaUsd, feeUsd, execPrice };
    if (clientOrderId) this.executedClientIds.set(clientOrderId, result);
    return result;
  }
}

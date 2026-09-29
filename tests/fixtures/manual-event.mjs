export class ManualEventSource {
  constructor({ initialProbability = 0.61, spread = 0.02 } = {}) {
    this.sequence = 0;
    this.probability = initialProbability;
    this.spread = spread;
  }
  setProbability(probability) { this.probability = Math.min(1, Math.max(0, Number(probability))); }
  async read() {
    this.sequence += 1;
    const half = this.spread / 2;
    return {
      bid: Math.max(0, this.probability - half),
      ask: Math.min(1, this.probability + half),
      observedAtMs: Date.now(),
      sequence: this.sequence,
      source: 'manual-demo'
    };
  }
}

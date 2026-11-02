// Fixed policy used by unit tests only.
export function testPolicy() {
  const now = Math.floor(Date.now() / 1000);
  return {
    version: 1,
    type: 'STEP',
    eventMarket: 'DEMO-FED-CUT',
    outcomeId: 'YES',
    consequence: 'SOL-PERP-LONG',
    steps: [
      { pBps: 3500, exposureUsd: 100 },
      { pBps: 5000, exposureUsd: 200 },
      { pBps: 6000, exposureUsd: 300 },
      { pBps: 7000, exposureUsd: 420 },
      { pBps: 8000, exposureUsd: 500 }
    ],
    killBelowBps: 3500,
    riskCapUsd: 500,
    maxLeverageBps: 20000,
    lossStopUsd: 50,
    hysteresisBps: 100,
    confirmationCount: 2,
    minRebalanceUsd: 25,
    maxOracleAgeSec: 20,
    maxSpreadBps: 1200,
    expiryTs: now + 7 * 86400,
    venue: 'PAPER',
    marketId: 'SOL-PERP'
  };
}

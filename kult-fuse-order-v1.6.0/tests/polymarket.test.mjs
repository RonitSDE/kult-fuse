import test from 'node:test';
import assert from 'node:assert/strict';
import { PolymarketEventSource } from '../src/adapters/event/polymarket-event.mjs';

// Shapes follow the public Gamma /markets and CLOB /book responses.
const gammaMarket = {
  slug: 'will-x-happen', question: 'Will X happen?', closed: false, endDate: '2030-01-01T00:00:00Z',
  outcomes: '["Yes","No"]', clobTokenIds: '["111","222"]'
};
const book = { bids: [{ price: '0.58', size: '100' }, { price: '0.61', size: '50' }], asks: [{ price: '0.66', size: '10' }, { price: '0.63', size: '40' }] };

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return { ok: false, status: 404, text: async () => 'nope' };
    return { ok: true, status: 200, json: async () => hit[1] };
  };
  return { impl, calls };
}

test('polymarket reads best bid/ask for the chosen outcome token', async () => {
  const f = fakeFetch({ '/markets?slug=will-x-happen': [gammaMarket], '/book?token_id=111': book });
  const src = new PolymarketEventSource({ market: 'will-x-happen', fetchImpl: f.impl });
  const info = await src.init();
  assert.equal(info.tokenId, '111');
  assert.equal(info.endDateMs, Date.parse('2030-01-01T00:00:00Z'));
  const o = await src.read();
  assert.equal(o.bid, 0.61);
  assert.equal(o.ask, 0.63);
  assert.equal(o.sequence, 1);
  assert.equal(o.source, 'polymarket:will-x-happen');
  assert.equal((await src.read()).sequence, 2);
});

test('polymarket picks the No token when asked', async () => {
  const f = fakeFetch({ '/markets?slug=will-x-happen': [gammaMarket], '/book?token_id=222': book });
  const src = new PolymarketEventSource({ market: 'will-x-happen', outcome: 'no', fetchImpl: f.impl });
  assert.equal((await src.init()).tokenId, '222');
});

test('polymarket rejects closed markets, unknown outcomes and one-sided books', async () => {
  const closed = fakeFetch({ '/markets?slug=': [{ ...gammaMarket, closed: true }] });
  await assert.rejects(() => new PolymarketEventSource({ market: 'will-x-happen', fetchImpl: closed.impl }).init(), /closed/);
  const ok = fakeFetch({ '/markets?slug=': [gammaMarket], '/book': { bids: [], asks: book.asks } });
  await assert.rejects(() => new PolymarketEventSource({ market: 'will-x-happen', outcome: 'Maybe', fetchImpl: ok.impl }).init(), /outcome "Maybe" not found/);
  await assert.rejects(() => new PolymarketEventSource({ market: 'will-x-happen', fetchImpl: ok.impl }).read(), /no bids/);
  const missing = fakeFetch({ '/markets?slug=': [] });
  await assert.rejects(() => new PolymarketEventSource({ market: 'nope', fetchImpl: missing.impl }).init(), /not found/);
});

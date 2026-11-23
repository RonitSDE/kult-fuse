import test from 'node:test';
import assert from 'node:assert/strict';
import { DFlowEventSource, yesQuoteFromBook, DFLOW_DEV_URL } from '../src/adapters/event/dflow-event.mjs';

const YES = 'YesMint1111111111111111111111111111111111111';
const market = { ticker: 'KXSOLD-26DEC05-T150', eventTicker: 'KXSOLD-26DEC05', title: 'SOL price on Dec 5?', yesSubTitle: '$150 or above', closeTime: 1893456000, status: 'active', yesBid: '0.41', yesAsk: '0.44', accounts: { usdc: { yesMint: YES, noMint: 'NoMint' } } };
const book = { sequence: 7, yes_bids: { '0.4100': 300, '0.4000': 900 }, no_bids: { '0.5700': 200, '0.5500': 50 } };

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return { ok: false, status: 404, text: async () => 'nope' };
    return { ok: true, status: 200, json: async () => hit[1] };
  };
  return { impl, calls };
}

test('book → YES quote: ask is the complement of the best NO bid, depth in USD', () => {
  const q = yesQuoteFromBook(book);
  assert.equal(q.bid, 0.41);
  assert.equal(q.ask, 0.43);
  assert.ok(Math.abs(q.bidDepthUsd - 123) < 1e-9);
  assert.ok(Math.abs(q.askDepthUsd - 86) < 1e-9);
  assert.equal(yesQuoteFromBook({ yes_bids: {}, no_bids: { '0.5': 1 } }), null);
  assert.equal(yesQuoteFromBook({ yes_bids: { '0.7': 1 }, no_bids: { '0.5': 1 } }), null, 'crossed book is rejected');
});

test('dflow uses the dev host without a key and binds market metadata', async () => {
  const f = fakeFetch({ [`/market/by-mint/${YES}`]: market, [`/orderbook/by-mint/${YES}`]: book });
  const src = new DFlowEventSource({ marketMint: YES, fetchImpl: f.impl });
  const info = await src.init();
  assert.ok(f.calls[0].url.startsWith(DFLOW_DEV_URL));
  assert.equal(info.question, 'SOL price on Dec 5? — $150 or above');
  assert.equal(info.endDateMs, 1893456000 * 1000);
  const o = await src.read();
  assert.equal(o.bid, 0.41); assert.equal(o.ask, 0.43);
  assert.equal(o.source, 'dflow:KXSOLD-26DEC05-T150');
  assert.equal(o.bookSequence, 7);
});

test('dflow falls back to market top of book with no depth when the book is unavailable', async () => {
  const f = fakeFetch({ [`/market/by-mint/${YES}`]: market });
  const src = new DFlowEventSource({ marketMint: YES, fetchImpl: f.impl });
  const o = await src.read();
  assert.equal(o.bid, 0.41); assert.equal(o.ask, 0.44);
  assert.equal(o.bidDepthUsd, null);
});

test('dflow refuses the NO mint and settled markets', async () => {
  const no = new DFlowEventSource({ marketMint: 'NoMint', fetchImpl: fakeFetch({ '/market/by-mint/NoMint': market }).impl });
  await assert.rejects(no.init(), /NO mint/);
  const done = new DFlowEventSource({ marketMint: YES, fetchImpl: fakeFetch({ '/market/by-mint/': { ...market, status: 'settled' } }).impl });
  await assert.rejects(done.init(), /settled/);
});

test('dflow sends the api key to the production host', async () => {
  const f = fakeFetch({ '/market/by-mint/': market });
  const src = new DFlowEventSource({ marketMint: YES, apiKey: 'k', fetchImpl: f.impl });
  await src.init();
  assert.ok(f.calls[0].url.startsWith('https://prediction-markets-api.dflow.net'));
  assert.equal(f.calls[0].headers['x-api-key'], 'k');
});

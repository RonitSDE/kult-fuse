import test from 'node:test';
import assert from 'node:assert/strict';
import { rpcList, fallbackFetch } from '../src/predict/rpc-fallback.mjs';

const A = 'https://a.example', B = 'https://b.example';
const fake = plan => { const calls = []; return { calls, fetchImpl: async url => { calls.push(url); const r = plan[url]; if (r instanceof Error) throw r; return { status: r }; } }; };

test('rpcList keeps order, drops blanks and duplicates, refuses mainnet and plain HTTP', () => {
  assert.deepEqual(rpcList(A, '', undefined, A, B), [A, B]);
  assert.throws(() => rpcList('https://api.mainnet-beta.solana.com'));
  assert.throws(() => rpcList('http://a.example'));
});

test('fallbackFetch stays on the primary when it answers', async () => {
  const f = fake({ [A]: 200, [B]: 200 });
  assert.equal((await fallbackFetch([A, B], { fetchImpl: f.fetchImpl })(A, {})).status, 200);
  assert.deepEqual(f.calls, [A]);
});

test('fallbackFetch moves to the backup on 429, 5xx or a network error', async () => {
  for (const failure of [429, 503, new Error('ECONNRESET')]) {
    const f = fake({ [A]: failure, [B]: 200 });
    assert.equal((await fallbackFetch([A, B], { fetchImpl: f.fetchImpl })(A, {})).status, 200);
    assert.deepEqual(f.calls, [A, B]);
  }
});

test('fallbackFetch does not retry a client error and returns the last answer when all fail', async () => {
  const f = fake({ [A]: 400, [B]: 200 });
  assert.equal((await fallbackFetch([A, B], { fetchImpl: f.fetchImpl })(A, {})).status, 400);
  const g = fake({ [A]: 503, [B]: 429 });
  assert.equal((await fallbackFetch([A, B], { fetchImpl: g.fetchImpl })(A, {})).status, 429);
});

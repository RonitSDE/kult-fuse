import test from 'node:test';
import assert from 'node:assert/strict';
import { testPolicy } from './fixtures/policy.mjs';
import { replayPolicy } from '../src/core/replay.mjs';

test('signature replay sequence matches expected deterministic outputs with hysteresis',()=>{
  const rows=replayPolicy(testPolicy(),[5800,6200,7100,5400,3200]);
  // Replay deliberately has no confirmation debounce; it proves the committed curve itself.
  assert.deepEqual(rows.map(r=>r.after),[200,300,420,200,0]);
  assert.equal(rows.at(-1).status,'KILLED');
});

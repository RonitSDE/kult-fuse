import test from 'node:test';
import assert from 'node:assert/strict';
import { setupChecklist } from '../src/http/setup.mjs';
import { Runtime } from '../src/http/runtime.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const key = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));

test('setup checklist names every missing piece and passes a complete config', () => {
  const empty = setupChecklist({});
  assert.ok(empty.every((i) => i.hint || i.ok));
  assert.deepEqual(empty.filter((i) => !i.ok).map((i) => i.id).sort(), ['idl', 'keys', 'market', 'program', 'token', 'venueKey'].sort());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idl-'));
  const idl = path.join(dir, 'kult_fuse.json'); fs.writeFileSync(idl, '{}');
  const full = setupChecklist({ DFLOW_MARKET_MINT: 'm', VELOCITY_PRIVATE_KEY_JSON: key, FUSE_PROGRAM_ID: 'p', FUSE_IDL_PATH: idl, FUSE_OWNER_PRIVATE_KEY_JSON: key, FUSE_ORACLE_PRIVATE_KEY_JSON: key, FUSE_EXECUTION_PRIVATE_KEY_JSON: key, FUSE_ADMIN_TOKEN: 'x'.repeat(32) });
  assert.ok(full.every((i) => i.ok), JSON.stringify(full.filter((i) => !i.ok)));
});

test('retired venues are flagged, not silently accepted', () => {
  const items = setupChecklist({ PERP_ADAPTER: 'drift' });
  assert.match(items.find((i) => i.id === 'venueKey').hint, /retired/);
});

test('runtime with no config starts in setup mode and still serves the committed policy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuse-'));
  const rt = await new Runtime({ DATA_DIR: dir, POLICY_FILE: './policy.example.json' }).start();
  assert.equal(rt.live, false);
  assert.match(rt.setupError, /DFLOW_MARKET_MINT/);
  const s = await rt.getState();
  assert.equal(s.mode, 'setup');
  assert.equal(s.integrity.onchain, false);
  assert.equal(s.policy.riskCapUsd, 30);
  assert.match(s.policyHash, /^[0-9a-f]{64}$/);
  assert.ok(s.setup.checklist.length >= 6);
  const proof = await rt.proof();
  assert.equal(proof.verifiedRun, null);
});

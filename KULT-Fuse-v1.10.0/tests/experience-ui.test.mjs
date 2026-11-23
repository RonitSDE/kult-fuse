import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { demoSnapshot, DEMO_LABELS, permittedByCurve, thresholdRows, isSyntheticState } from '../web/experience.mjs';
import { testPolicy } from './fixtures/policy.mjs';
const policy = testPolicy();

test('synthetic fixture cannot be labeled as live even when backend mode says live', () => {
  assert.equal(isSyntheticState({ integrity: { mode: 'live', buildTag: 'ui-preview' } }), true);
  assert.equal(isSyntheticState({ integrity: { buildSha: 'PREVIEW_SYNTHETIC_DATA' } }), true);
  assert.equal(isSyntheticState({ market: { ticker: 'PREVIEW-TICKER' } }), true);
  assert.equal(isSyntheticState({ integrity: { network: 'devnet', buildTag: 'release' } }), false);
});
test('guided walkthrough contains four distinct nonexecuting states', () => {
  assert.equal(DEMO_LABELS.length, 4);
  for (let i = 0; i < 4; i++) {
    const snap = demoSnapshot(policy, i);
    assert.equal(snap.venueExecution, false);
    assert.equal(snap.anchor, false);
    assert.equal(snap.mode, 'SIMULATION_NOT_EXECUTED');
    assert.match(snap.title, /not executed|REFUSE|KILL/);
  }
});
test('first stage stays within hard cap and curve', () => {
  const s = demoSnapshot(policy, 0);
  assert.ok(s.requested <= s.permitted);
  assert.ok(s.permitted <= policy.riskCapUsd);
  assert.equal(s.refused, false);
});
test('second stage refuses over-cap target', () => {
  const s = demoSnapshot(policy, 1);
  assert.equal(s.reason, 'RISK_CAP_EXCEEDED');
  assert.ok(s.requested > policy.riskCapUsd);
  assert.equal(s.refused, true);
});
test('kill stage zeroes policy target without claiming a venue close', () => {
  const s = demoSnapshot(policy, 2);
  assert.equal(s.permitted, 0);
  assert.equal(s.killed, true);
  assert.match(s.detail, /separately signed, filled and verified/i);
});
test('post-kill proposal refuses even after recovered probability', () => {
  const s = demoSnapshot(policy, 3);
  assert.equal(s.permitted, 0);
  assert.equal(s.refused, true);
  assert.equal(s.reason, 'MANDATE_KILLED');
  assert.ok(s.probability > policy.killBelowBps / 10000);
});
test('mobile threshold rows accurately represent the curve and selected probability', () => {
  const rows = thresholdRows(policy, 0.65);
  assert.ok(rows.length >= 3);
  assert.equal(rows.filter(r => r.active).length, 1);
  const active = rows.find(r => r.active);
  assert.equal(active.usd, permittedByCurve(policy, 6500));
  const dead = thresholdRows(policy, 0.01);
  assert.equal(dead[0].active, true);
});
test('untrusted or absent policy is not accidentally presented as authorized', () => {
  assert.equal(permittedByCurve(null, 6000), 0);
  assert.equal(permittedByCurve(policy, Number.NaN), 0);
  assert.throws(() => demoSnapshot(null, 0));
  assert.throws(() => demoSnapshot(policy, -1));
  assert.throws(() => demoSnapshot(policy, 4));
});
test('web source contains explicit split labels, guided controls and authority disclosure', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  for (const id of ['demoStages', 'demoPrev', 'demoNext', 'presentationBar', 'mobileCurve', 'exitPresentation']) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /worker still controls the Velocity signing key/);
  assert.match(js, /SIMULATION · NOT EXECUTED/);
  assert.match(js, /Synthetic fixture · not live/);
  assert.match(js, /NOT EXECUTED/);
});
test('server and preview serve .mjs as JavaScript for cross-browser module imports', () => {
  for (const file of ['src/http/server.mjs', 'scripts/ui-preview.mjs']) {
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(text, /\.mjs'\s*:\s*'text\/javascript/);
  }
});

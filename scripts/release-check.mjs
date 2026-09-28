import { spawnSync } from 'node:child_process';
const run = (label, args) => {
  console.log(`\n== ${label} ==`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status || 1);
};
run('TESTS', ['--test','tests/core.test.mjs','tests/engine.test.mjs','tests/replay.test.mjs']);
run('SIMULATION', ['scripts/simulate.mjs']);
if ((process.env.KULT_FUSE_MODE || 'demo') === 'live' || String(process.env.FUSE_ONCHAIN || '0') === '1') {
  run('PREFLIGHT', ['scripts/preflight.mjs']);
}
console.log('\nRELEASE CHECK PASS');

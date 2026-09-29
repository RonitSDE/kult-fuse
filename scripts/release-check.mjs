import { spawnSync } from 'node:child_process';
const run = (label, args) => {
  console.log(`\n== ${label} ==`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status || 1);
};
run('TESTS', ['--test','tests/core.test.mjs','tests/engine.test.mjs','tests/replay.test.mjs','tests/polymarket.test.mjs']);
run('PREFLIGHT', ['scripts/preflight.mjs']);
console.log('\nRELEASE CHECK PASS');

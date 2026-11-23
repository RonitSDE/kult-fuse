import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const run = (label, args) => {
  console.log(`\n== ${label} ==`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status || 1);
};
run('TESTS', ['--test', ...readdirSync('tests').filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `tests/${name}`)]);
run('PREFLIGHT', ['scripts/preflight.mjs']);
console.log('\nRELEASE CHECK PASS');

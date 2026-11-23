import fs from 'node:fs';
const env = process.env;
const checks = [];
const add = (name, ok, detail='') => checks.push({name, ok:Boolean(ok), detail});
add('Node >=24', Number(process.versions.node.split('.')[0]) >= 24, process.versions.node);
add('Build SHA set', env.BUILD_SHA && env.BUILD_SHA !== 'DEV_UNSET', env.BUILD_SHA || 'unset');
add('Operator token', env.FUSE_ADMIN_TOKEN && !env.FUSE_ADMIN_TOKEN.startsWith('CHANGE_ME') && env.FUSE_ADMIN_TOKEN.length >= 24, 'FUSE_ADMIN_TOKEN, 24+ chars');
add('Solana RPC', env.SOLANA_RPC_URL && !env.SOLANA_RPC_URL.includes('YOUR_API_KEY'), env.SOLANA_CLUSTER || 'devnet');

const source = (env.EVENT_SOURCE || 'dflow').toLowerCase();
if (source === 'dflow') {
  add('DFlow market mint (YES side)', env.DFLOW_MARKET_MINT, env.DFLOW_MARKET_MINT || 'run npm run markets');
  add('DFlow host', true, env.DFLOW_API_KEY ? 'production (API key set)' : 'dev host, no key');
} else if (source === 'polymarket') {
  add('Polymarket market explicitly selected', Boolean(env.POLYMARKET_MARKET), env.POLYMARKET_MARKET || 'unset');
} else add('Event source', false, `unsupported EVENT_SOURCE=${source}`);

const policyFile = env.POLICY_FILE || './policy.example.json';
add('Policy file', fs.existsSync(policyFile), policyFile);

const venue = (env.PERP_ADAPTER || 'velocity').toLowerCase();
if (venue === 'velocity') {
  const venueEnv = env.VELOCITY_ENV || env.SOLANA_CLUSTER || 'devnet';
  const slip = Number(env.VELOCITY_MAX_SLIPPAGE_BPS || env.PERP_MAX_SLIPPAGE_BPS || 50);
  add('Velocity private key', Boolean(env.VELOCITY_PRIVATE_KEY_JSON), 'required to execute orders');
  add('Velocity RPC', Boolean(env.VELOCITY_RPC_URL || env.SOLANA_RPC_URL), venueEnv);
  add('Venue and Fuse cluster', (env.SOLANA_CLUSTER || 'devnet') === venueEnv, 'use one cluster for live mandate proof');
  add('Velocity slippage limit', slip > 0 && slip <= 1000, `${slip} bps (1–1000)`);
} else if (venue !== 'driver') add('Supported venue', false, `${venue}: use velocity or driver`);

const idlPath = env.FUSE_IDL_PATH || './deploy/idl/kult_fuse.json';
add('Fuse program ID', env.FUSE_PROGRAM_ID, 'required');
add('Fuse IDL', fs.existsSync(idlPath), idlPath);
add('Fuse owner key', env.FUSE_OWNER_PRIVATE_KEY_JSON, 'required');
add('Fuse oracle key', env.FUSE_ORACLE_PRIVATE_KEY_JSON, 'required');
add('Fuse execution key', env.FUSE_EXECUTION_PRIVATE_KEY_JSON, 'required');
if (env.VELOCITY_PRIVATE_KEY_JSON && env.FUSE_OWNER_PRIVATE_KEY_JSON) {
  const normalize = (s) => { try { return JSON.stringify(JSON.parse(s)); } catch { return String(s); } };
  add('Trading key is not the owner key', normalize(env.VELOCITY_PRIVATE_KEY_JSON) !== normalize(env.FUSE_OWNER_PRIVATE_KEY_JSON), 'keep custody and trading credentials separate');
}
if (env.FUSE_OWNER_PRIVATE_KEY_JSON && env.FUSE_ORACLE_PRIVATE_KEY_JSON && env.FUSE_EXECUTION_PRIVATE_KEY_JSON) {
  const canonical = (s) => { try { return JSON.stringify(JSON.parse(s)); } catch { return String(s); } };
  add('Owner/oracle/execution role key separation', new Set([env.FUSE_OWNER_PRIVATE_KEY_JSON, env.FUSE_ORACLE_PRIVATE_KEY_JSON, env.FUSE_EXECUTION_PRIVATE_KEY_JSON].map(canonical)).size === 3, 'three distinct role keypairs are required');
}

for (const c of checks) console.log(`${c.ok?'PASS':'FAIL'}  ${c.name}${c.detail?` — ${c.detail}`:''}`);
if (checks.some(c=>!c.ok)) process.exitCode=1;

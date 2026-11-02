import fs from 'node:fs';
const env = process.env;
const checks = [];
const add = (name, ok, detail='') => checks.push({name, ok:Boolean(ok), detail});
add('Node >=22', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node);
add('Build SHA set', env.BUILD_SHA && env.BUILD_SHA !== 'DEV_UNSET', env.BUILD_SHA || 'unset');
add('Operator token', env.FUSE_ADMIN_TOKEN && !env.FUSE_ADMIN_TOKEN.startsWith('CHANGE_ME') && env.FUSE_ADMIN_TOKEN.length >= 24, 'FUSE_ADMIN_TOKEN, 24+ chars');
add('Solana RPC', env.SOLANA_RPC_URL && !env.SOLANA_RPC_URL.includes('YOUR_API_KEY'), env.SOLANA_CLUSTER || 'devnet');

const source = (env.EVENT_SOURCE || 'polymarket').toLowerCase();
if (source === 'polymarket') {
  const market = env.POLYMARKET_MARKET || 'unset';
  add('Polymarket market explicitly selected', Boolean(env.POLYMARKET_MARKET), market);
}
else if (source === 'dflow') {
  add('DFlow API key', env.DFLOW_API_KEY, 'required for dflow');
  add('DFlow market mint', env.DFLOW_MARKET_MINT, 'required for dflow');
} else add('Event source', false, `unsupported EVENT_SOURCE=${source}`);

const policyFile = env.POLICY_FILE || './policy.example.json';
add('Policy file', fs.existsSync(policyFile), policyFile);

const venue = (env.PERP_ADAPTER || 'drift').toLowerCase();
if (venue === 'flash') {
  add('Flash private key', env.FLASH_PRIVATE_KEY_JSON, 'required for Flash');
  add('Flash pool', env.FLASH_POOL, env.FLASH_POOL || 'unset');
}
if (venue === 'drift') {
  add('Drift private key', Boolean(env.DRIFT_PRIVATE_KEY_JSON), 'required to execute orders');
  add('Drift RPC', Boolean(env.DRIFT_RPC_URL || env.SOLANA_RPC_URL), env.DRIFT_ENV || 'devnet');
  add('Venue and Fuse cluster', (env.SOLANA_CLUSTER || 'devnet') === (env.DRIFT_ENV || 'devnet'), 'use one cluster for live mandate proof');
  add('Drift slippage limit', Number(env.DRIFT_MAX_SLIPPAGE_BPS || env.PERP_MAX_SLIPPAGE_BPS || 50) > 0 && Number(env.DRIFT_MAX_SLIPPAGE_BPS || env.PERP_MAX_SLIPPAGE_BPS || 50) <= 1000, '1–1000 bps');
}
if (!['flash', 'drift', 'driver'].includes(venue)) add('Supported venue', false, venue);

const idlPath = env.FUSE_IDL_PATH || './deploy/idl/kult_fuse.json';
add('Fuse program ID', env.FUSE_PROGRAM_ID, 'required');
add('Fuse IDL', fs.existsSync(idlPath), idlPath);
add('Fuse owner key', env.FUSE_OWNER_PRIVATE_KEY_JSON, 'required');
add('Fuse oracle key', env.FUSE_ORACLE_PRIVATE_KEY_JSON, 'required');
add('Fuse execution key', env.FUSE_EXECUTION_PRIVATE_KEY_JSON, 'required');

for (const c of checks) console.log(`${c.ok?'PASS':'FAIL'}  ${c.name}${c.detail?` — ${c.detail}`:''}`);
if (checks.some(c=>!c.ok)) process.exitCode=1;

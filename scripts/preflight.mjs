import fs from 'node:fs';
import { DEFAULT_POLYMARKET_MARKET } from '../src/adapters/event/polymarket-event.mjs';
const env = process.env;
const checks = [];
const add = (name, ok, detail='') => checks.push({name, ok:Boolean(ok), detail});
add('Node >=22', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node);
add('Build SHA set', env.BUILD_SHA && env.BUILD_SHA !== 'DEV_UNSET', env.BUILD_SHA || 'unset');
add('Operator token', env.FUSE_ADMIN_TOKEN && !env.FUSE_ADMIN_TOKEN.startsWith('CHANGE_ME') && env.FUSE_ADMIN_TOKEN.length >= 24, 'FUSE_ADMIN_TOKEN, 24+ chars');
add('Solana RPC', env.SOLANA_RPC_URL && !env.SOLANA_RPC_URL.includes('YOUR_API_KEY'), env.SOLANA_CLUSTER || 'devnet');

const source = (env.EVENT_SOURCE || 'polymarket').toLowerCase();
if (source === 'polymarket') {
  const market = env.POLYMARKET_MARKET || DEFAULT_POLYMARKET_MARKET;
  add('Polymarket market', market, market);
}
else if (source === 'dflow') {
  add('DFlow API key', env.DFLOW_API_KEY, 'required for dflow');
  add('DFlow market mint', env.DFLOW_MARKET_MINT, 'required for dflow');
} else add('Event source', false, `unsupported EVENT_SOURCE=${source}`);

const policyFile = env.POLICY_FILE || './policy.example.json';
add('Policy file', fs.existsSync(policyFile), policyFile);

if ((env.PERP_ADAPTER || 'flash') === 'flash') {
  add('Flash private key', env.FLASH_PRIVATE_KEY_JSON, 'required for Flash');
  add('Flash pool', env.FLASH_POOL, env.FLASH_POOL || 'unset');
}

const idlPath = env.FUSE_IDL_PATH || './contracts/fuse-anchor/target/idl/kult_fuse.json';
add('Fuse program ID', env.FUSE_PROGRAM_ID, 'required');
add('Fuse IDL', fs.existsSync(idlPath), idlPath);
add('Fuse owner key', env.FUSE_OWNER_PRIVATE_KEY_JSON, 'required');
add('Fuse oracle key', env.FUSE_ORACLE_PRIVATE_KEY_JSON, 'required');
add('Fuse execution key', env.FUSE_EXECUTION_PRIVATE_KEY_JSON, 'required');

for (const c of checks) console.log(`${c.ok?'PASS':'FAIL'}  ${c.name}${c.detail?` — ${c.detail}`:''}`);
if (checks.some(c=>!c.ok)) process.exitCode=1;

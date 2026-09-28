const env = process.env;
const checks = [];
const add = (name, ok, detail='') => checks.push({name, ok:Boolean(ok), detail});
add('Node >=20', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node);
add('Build SHA set', env.BUILD_SHA && env.BUILD_SHA !== 'DEV_UNSET', env.BUILD_SHA || 'unset');
if ((env.KULT_FUSE_MODE || 'demo') === 'live') {
  add('Admin token', env.FUSE_ADMIN_TOKEN && !env.FUSE_ADMIN_TOKEN.startsWith('CHANGE_ME'), 'required in live');
  add('DFlow API key', env.DFLOW_API_KEY, 'required in live');
  add('DFlow market mint', env.DFLOW_MARKET_MINT, 'required in live');
  add('Solana RPC', env.SOLANA_RPC_URL, 'required in live');
}
if ((env.PERP_ADAPTER || 'paper') === 'flash') {
  add('Flash private key', env.FLASH_PRIVATE_KEY_JSON, 'required for Flash');
  add('Flash pool', env.FLASH_POOL, env.FLASH_POOL || 'unset');
}
if (String(env.FUSE_ONCHAIN || '0') === '1') {
  add('Fuse program ID', env.FUSE_PROGRAM_ID, 'required onchain');
  add('Fuse PDA', env.FUSE_PDA, 'required onchain');
}
for (const c of checks) console.log(`${c.ok?'PASS':'FAIL'}  ${c.name}${c.detail?` — ${c.detail}`:''}`);
if (checks.some(c=>!c.ok)) process.exitCode=1;

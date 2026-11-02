import fs from 'node:fs/promises';
import { AnchorFuseClient } from '../src/adapters/store/anchor-fuse-client.mjs';
import { policyHash } from '../src/core/policy.mjs';

const web3=await import('@solana/web3.js');
const policy=JSON.parse(await fs.readFile(process.env.POLICY_FILE||'./policy.example.json','utf8'));
const pub=(json)=>web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json))).publicKey.toBase58();
const client=new AnchorFuseClient({...process.env,FUSE_AUTHORITY_PRIVATE_KEY_JSON:process.env.FUSE_OWNER_PRIVATE_KEY_JSON});
await client.init();
const fuseId=BigInt(process.env.FUSE_ID || Date.now());
const result=await client.initFuse({
  fuseId,
  policy,
  agent: process.env.FUSE_AGENT_PUBKEY || pub(process.env.FUSE_OWNER_PRIVATE_KEY_JSON),
  executionAuthority: pub(process.env.FUSE_EXECUTION_PRIVATE_KEY_JSON),
  oracleAuthority: pub(process.env.FUSE_ORACLE_PRIVATE_KEY_JSON)
});
console.log(JSON.stringify({...result,fuseId:String(fuseId),policyHash:policyHash(policy)},null,2));
console.log(`Set FUSE_PDA=${result.fuse}`);

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=async x=>readFile(path.join(root,x),'utf8');
test('PREDICT verifier uses official swap Anchor discriminator',async()=>{
 const src=await source('src/predict/proof.mjs');
 const actual=[...createHash('sha256').update('global:swap').digest().subarray(0,8)];
 assert.deepEqual(actual,[248,198,158,145,225,117,135,200]);
 assert.match(src,/anchorIx\('swap'\)/);
 assert.doesNotMatch(src,/anchorIx\('swap_yes_no'\)/);
});
test('PREDICT quote imports source-reviewed SDK math rather than undocumented helper',async()=>{
 const src=await source('apps/predict/src/predict-client.js');
 assert.match(src,/from '@pm-amm\/sdk\/math'/);
 assert.match(src,/estimateSwapOutput\(/);
 assert.match(src,/SWAP_FEE_BPS/);
 assert.match(src,/minRaw=Math\.floor\(quote\.quotedRaw\*/);
});
test('PREDICT runtime permits devnet RPC and sponsor faucet in browser CSP',async()=>{
 const src=await source('src/http/server.mjs');
 assert.match(src,/https:\/\/api\.devnet\.solana\.com/);
 assert.match(src,/https:\/\/pm-amm-devnet\.vercel\.app/);
 assert.match(src,/predictCsp/);
});
test('PREDICT deploy scripts do not call removed helper synchronizer',async()=>{
 for(const name of ['render.yaml','deploy/Dockerfile'])assert.doesNotMatch(await source(name),/sync:helpers/);
});

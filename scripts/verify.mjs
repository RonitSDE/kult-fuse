import { FileStore } from '../src/adapters/store/file-store.mjs';
import { verifyFuse } from '../src/core/verifier.mjs';
const store=new FileStore(process.env.DATA_DIR||'./.data');
const fuse=await store.read('fuse');const receipts=await store.read('receipts',[]);
if(!fuse){console.error('No local Fuse state found. Start the server (npm start) so it creates a Fuse first.');process.exit(2)}
const result=verifyFuse({fuse,receipts});
console.log('\nKULT FUSE VERIFIER\n==================');
for(const c of result.checks) console.log(`${c.ok?'PASS':'FAIL'}  ${c.name.padEnd(22)} ${String(c.actual)}`);
console.log(`\n${result.summary}`);process.exit(result.ok?0:1);

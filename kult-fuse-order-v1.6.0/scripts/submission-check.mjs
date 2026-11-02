// Run from the exact tagged release with a filled SUBMISSION_MANIFEST.json.
// The final step invokes the independent RPC verifier; no worker keys are needed.
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { assessSubmission } from '../src/core/submission.mjs';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i+1] : null; };
const manifest = JSON.parse(await fs.readFile(arg('--manifest') || './SUBMISSION_MANIFEST.json','utf8'));
const publicUrl = arg('--url') || manifest.publicUrl;
const get = async (route) => {
  if (!publicUrl) return {};
  try {
    const res=await fetch(new URL(route,publicUrl),{signal:AbortSignal.timeout(10000)});
    if(!res.ok) return { requestError:`HTTP ${res.status}` };
    return await res.json();
  } catch(e) { return { requestError:e.message }; }
};
const [health,state,proof] = await Promise.all(['/healthz','/api/state','/api/proof'].map(get));
const report=assessSubmission({manifest,health,state,proof,publicUrl});
for(const c of report.checks) console.log(`${c.ok?'PASS':'FAIL'} ${c.name}${c.detail?` — ${c.detail}`:''}`);
if(!report.ok){console.error('SUBMISSION NOT READY: supply real, matching public proof.');process.exit(1)}
console.log('\nChecking Solana and Drift transactions independently…');
const verified=spawnSync(process.execPath,['scripts/verify.mjs','--url',publicUrl],{stdio:'inherit',env:process.env});
if(verified.status!==0)process.exit(verified.status||1);
console.log('\nSUBMISSION PROOF PASS. Review the video and commit tag manually before submitting.');

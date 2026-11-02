import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSubmission } from '../src/core/submission.mjs';

const sig=n=>'ABCDEFGHJKLMNPQRSTUVWXYZ'[n].repeat(88);
const url='https://fuse.example.org';
function fixture(){
  const names=['create','arm','target','kill','driftOpen','driftResize','driftClose'];
  const txs=Object.fromEntries(names.map((name,i)=>[name,sig(i+1)]));
  const hashes=['a','b','c'];
  const receipts=hashes.map((hash,i)=>({hash,fuseId:'fuse-1',txSignature:txs[['driftOpen','driftResize','driftClose'][i]],anchor:{status:'ANCHORED',signature:sig(8+i)}}));
  return {
    publicUrl:url,
    manifest:{publicUrl:url,healthUrl:url+'/healthz',buildSha:'a'.repeat(40),buildTag:'fuse-v1.6.0',demoVideo:'https://example.org/demo',fuseNetwork:'devnet',venueNetwork:'devnet',eventMarket:'sol-event',eventToPerpThesis:'A YES outcome would directly change demand for SOL. This event expires before the mandate and no other venue is traded.',programId:'program',fuseAccount:'pda',proofTransactions:txs,authorityBound:false,venueKeyCanBypassFuse:true},
    health:{status:'ok',service:'kult-fuse',buildSha:'a'.repeat(40),network:'devnet'},
    state:{integrity:{buildSha:'a'.repeat(40),buildTag:'fuse-v1.6.0',network:'devnet',programId:'program',fusePda:'pda',onchain:true,eventSource:'polymarket',perpAdapter:'drift',venueAuthority:{bound:false}},market:{id:'sol-event'},quote:{source:'polymarket:sol-event',quality:true,ageSec:2,bid:0.49,ask:0.51},fuse:{id:'fuse-1',status:'KILLED',policy:{eventMarket:'sol-event',maxOracleAgeSec:20,venue:'DRIFT',marketId:'SOL-PERP'}},position:{exposureUsd:0},receipts},
    proof:{fuseAccount:{value:'pda'},transactions:Object.fromEntries(names.map((name,i)=>[[ 'driftOpen','driftResize','driftClose' ].includes(name)?({driftOpen:'venueOpen',driftResize:'venueResize',driftClose:'venueClose'})[name]:name,{value:txs[name],url:`https://explorer.example.org/tx/${txs[name]}`} ])),verifiedRun:{source:'live',receipts}},
  };
}

test('submission gate refuses the blank source manifest and an unreachable host',()=>{
  const v=assessSubmission({manifest:{},health:{},state:{},proof:{},publicUrl:''});
  assert.equal(v.ok,false);
  assert.ok(v.checks.some(c=>c.name==='driftOpen signature matches live mandate'&&!c.ok));
});

test('submission gate requires public live quote and proof links from the same mandate',()=>{
  const v=fixture();
  assert.equal(assessSubmission(v).ok,true,JSON.stringify(assessSubmission(v).checks.filter(c=>!c.ok)));
  v.proof.transactions.venueClose.value=sig(9);
  v.state.quote.quality=false;
  const broken=assessSubmission(v);
  assert.equal(broken.ok,false);
  assert.ok(broken.checks.some(c=>c.name==='driftClose signature matches live mandate'&&!c.ok));
  assert.ok(broken.checks.some(c=>c.name==='Usable live Polymarket quote displayed'&&!c.ok));
});

test('submission gate refuses receipts without fills or a killed mandate with residual exposure',()=>{
  const v=fixture();
  v.state.receipts=[];
  v.proof.verifiedRun=null;
  v.state.position.exposureUsd=8;
  assert.equal(assessSubmission(v).ok,false);
});

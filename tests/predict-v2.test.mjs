import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp,rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PROGRAM_ID,DEVNET_MUSDC,evaluatePrediction,normalizeMarketAccount } from '../src/predict/policy.mjs';
import { decodeBase58,verifyPredictSwapTx,statsFromReceipts } from '../src/predict/proof.mjs';
import {createPredictRegistry} from '../src/predict/registry.mjs';
const wallet='W'.repeat(40),marketPda='M'.repeat(42),signature='s'.repeat(87),now=Date.now();
const market={marketPda,endTs:Math.floor(now/1000)+2000,price:.52,resolved:false,observedAtMs:now};
const mandate={wallet,marketPda,side:'either',killed:false,spent:0,maxSingle:10,maxTotal:25,maxSlippageBps:100,expiresAtMs:now+3600000};
const proposal={wallet,marketPda,side:'yes',amount:5,minOutRaw:10000,quoteAtMs:now,quoteMarketPda:marketPda};
const policy=(patch={},mandatePatch={},marketPatch={})=>evaluatePrediction({proposal:{...proposal,...patch},mandate:{...mandate,...mandatePatch},market:{...market,...marketPatch},nowMs:now});
test('PREDICT mandate permits a fresh bounded quote',()=>assert.equal(policy().status,'ALLOW_AS_APP_CHECK'));
test('PREDICT mandate rejects missing wallet',()=>assert.match(policy({wallet:null}).reason,/wallet/i));
test('PREDICT mandate denies over-per-trade limit',()=>assert.equal(policy({amount:11}).status,'REFUSE'));
test('PREDICT mandate denies aggregate overspend',()=>assert.equal(policy({amount:6},{spent:20}).status,'REFUSE'));
test('PREDICT mandate denies after owner kill',()=>assert.match(policy({},{killed:true}).reason,/paused/));
test('PREDICT mandate denies after mandate expiration',()=>assert.match(policy({},{expiresAtMs:now-1}).reason,/expired/));
test('PREDICT mandate denies expired market',()=>assert.match(policy({}, {},{endTs:Math.floor(now/1000)-1}).reason,/expired/));
test('PREDICT mandate denies stale read',()=>assert.match(policy({}, {},{observedAtMs:now-31_000}).reason,/Stale/));
test('PREDICT mandate denies stale quote',()=>assert.match(policy({quoteAtMs:now-16_000}).reason,/expired/));
test('PREDICT mandate denies cross-market quote',()=>assert.match(policy({quoteMarketPda:'different'}).reason,/different market/));
test('PREDICT mandate denies mismatched signer',()=>assert.match(policy({wallet:'different'}).reason,/Wallet changed/));
test('PREDICT mandate denies wrong side',()=>assert.match(policy({side:'no'},{side:'yes'}).reason,/Side not approved/));
test('PREDICT mandate denies zero quote output',()=>assert.match(policy({minOutRaw:0}).reason,/No validated/));
test('PREDICT mandate denies invalid tolerance',()=>assert.match(policy({}, {maxSlippageBps:999}).reason,/Slippage/));
test('PREDICT market normalizes onchain byte names',()=>{const m=normalizeMarketAccount({pda:marketPda,raw:{marketId:{toNumber:()=>7},name:[72,105,0,0],endTs:{toNumber:()=>1700000000},resolved:false,winningSide:0},price:.45});assert.equal(m.name,'Hi');assert.equal(m.marketId,7);});
test('PREDICT decoder correctly handles base58 zeros',()=>assert.deepEqual([...decodeBase58('1112')],[0,0,0,1]));
// Fake transaction must match actual Anchor swap discriminator, signature,
// market, PREDICT program and token transfers to be admitted to metrics.
const base58chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf){let num=BigInt('0x'+Buffer.from(buf).toString('hex'));let out='';while(num>0n){out=base58chars[Number(num%58n)]+out;num/=58n;}return [...buf].filter((_,i)=>[...buf].slice(0,i+1).every(x=>x===0)).length?('1'.repeat([...buf].findIndex(x=>x!==0))+out):out;}
function mockTx({programId=PROGRAM_ID,discord=false,outcomeGain=true,spent=true,accountMarket=true,signer=true,memo='kult-fuse:predict:v2'}={}){
 const discriminator=createHash('sha256').update(`global:${discord?'deposit_liquidity':'swap'}`).digest().subarray(0,8);
 const balances=(collateral,outcome,dao)=>[{owner:wallet,mint:DEVNET_MUSDC,uiTokenAmount:{amount:String(collateral)}},{owner:wallet,mint:'Y'.repeat(40),uiTokenAmount:{amount:String(outcome)}},{owner:'4qXyczAr5DuBVaHUwmZT5Xt6hgQ6RwqBYcFGtrv8QEph',mint:DEVNET_MUSDC,uiTokenAmount:{amount:String(dao)}}];
 return {blockTime:Math.floor(Date.now()/1000),meta:{err:null,preTokenBalances:balances(10000000n,0n,0n),postTokenBalances:balances(spent?5000000n:10000000n,outcomeGain?6000000n:0n,50000n)},transaction:{message:{accountKeys:[{pubkey:wallet,signer},{pubkey:marketPda,signer:false},{pubkey:PROGRAM_ID,signer:false}],instructions:[{programId,data:b58(discriminator),accounts:accountMarket?[marketPda,wallet]:[wallet]},...(memo?[{programId:'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',program:'spl-memo',parsed:memo}]:[])]}}};
}
test('Onchain verifier counts only confirmed PREDICT swap with net collateral debit/outcome credit',()=>{const result=verifyPredictSwapTx(mockTx(),{signature,wallet,marketPda,expectedMints:{yes:'Y'.repeat(40),no:'N'.repeat(40)}});assert.equal(result.ok,true);assert.equal(result.spent,5);assert.equal(result.feeEstimate,.1);assert.equal(result.daoFeeObservedMUsdc,.05);});
test('Onchain verifier rejects unknown protocol calls',()=>assert.equal(verifyPredictSwapTx(mockTx({programId:'other'}),{signature,wallet,marketPda}).ok,false));
test('Onchain verifier rejects LP deposit from trade metrics',()=>assert.equal(verifyPredictSwapTx(mockTx({discord:true}),{signature,wallet,marketPda}).ok,false));
test('Onchain verifier rejects no outcome token credit',()=>assert.equal(verifyPredictSwapTx(mockTx({outcomeGain:false}),{signature,wallet,marketPda}).ok,false));
test('Onchain verifier rejects no mUSDC debit',()=>assert.equal(verifyPredictSwapTx(mockTx({spent:false}),{signature,wallet,marketPda}).ok,false));
test('Onchain verifier rejects absent wallet signer',()=>assert.equal(verifyPredictSwapTx(mockTx({signer:false}),{signature,wallet,marketPda}).ok,false));
test('Onchain verifier rejects failed transactions',()=>{const t=mockTx();t.meta.err={InstructionError:[0,'custom']};assert.equal(verifyPredictSwapTx(t,{signature,wallet,marketPda}).ok,false);});
test('Registry deduplicates confirmed signatures and recomputes stats atomically',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'fuse-predict-'));try{const r=createPredictRegistry({storePath:path.join(dir,'receipts.json'),lookup:async()=>mockTx(),resolveMarketMints:async()=>({yes:'Y'.repeat(40),no:'N'.repeat(40)})});const a=await r.record({signature,wallet,marketPda,expectedMints:{yes:'Y'.repeat(40),no:'N'.repeat(40)}});assert.equal(a.verified,true);const b=await r.record({signature,wallet,marketPda,expectedMints:{yes:'Y'.repeat(40),no:'N'.repeat(40)}});assert.equal(b.alreadyRecorded,true);assert.equal((await r.stats()).confirmedSwaps,1);}finally{await rm(dir,{recursive:true,force:true});}});
test('Scoreboard does not accept synthetic or failed records',()=>{const s=statsFromReceipts([{ok:false,spent:999},{ok:true,evidence:'PAPER',spent:300},{ok:true,evidence:'CONFIRMED_ONCHAIN_SWAP',wallet,spent:5,feeEstimate:.1}]);assert.equal(s.confirmedSwaps,1);assert.equal(s.uniqueTradingWallets,1);assert.equal(s.mUsdcVolume,5);});

test('PREDICT swap discriminator matches program IDL, not invented instruction name',()=>{
  assert.deepEqual([...createHash('sha256').update('global:swap').digest().subarray(0,8)],[248,198,158,145,225,117,135,200]);
});
test('Verifier refuses an outcome mint from a different market',()=>{
 const t=mockTx();
 const result=verifyPredictSwapTx(t,{signature,wallet,marketPda,expectedMints:{yes:'otherYES',no:'otherNO'}});
 assert.equal(result.ok,false);assert.match(result.message,/selected market/i);
});
test('Verifier refuses PREDICT instruction that targets another market',()=>{
 const t=mockTx({accountMarket:false});
 const result=verifyPredictSwapTx(t,{signature,wallet,marketPda,expectedMints:{yes:'Y'.repeat(40),no:'N'.repeat(40)}});
 assert.equal(result.ok,false);
});

test('v2.0.2: a real PREDICT swap without the KULT Fuse memo is not counted as app traction',()=>{
 const opts={signature,wallet,marketPda,expectedMints:{yes:'Y'.repeat(40),no:'N'.repeat(40)}};
 const plain=verifyPredictSwapTx(mockTx({memo:null}),opts);
 assert.equal(plain.ok,false); assert.match(plain.message,/not sent through KULT Fuse/);
 assert.equal(verifyPredictSwapTx(mockTx({memo:'someone-else'}),opts).ok,false);
 const tagged=verifyPredictSwapTx(mockTx(),opts);
 assert.equal(tagged.ok,true); assert.equal(tagged.attribution,'SELF_DECLARED_MEMO');
 assert.equal(verifyPredictSwapTx(mockTx({memo:null}),{...opts,requireAppMemo:false}).ok,true,'operators can opt out explicitly');
});

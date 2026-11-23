import test from 'node:test';
import assert from 'node:assert/strict';
import { KalshiPublicObserver, kalshiBookSummary, validKalshiTicker, compareKalshiToDflow, KALSHI_PUBLIC_PROD } from '../src/adapters/event/kalshi-observer.mjs';
import { buildDecisionJournal } from '../src/core/decision-journal.mjs';
import fs from 'node:fs';
const response = (body,status=200) => ({ ok:status===200,status,headers:{get:()=>null},text:async()=>JSON.stringify(body) });
const market={market:{ticker:'KXSOL-26NOV23-YES',title:'Will SOL reach a threshold?',status:'active',event_ticker:'KXSOL-26NOV23',close_time:'2026-11-24T16:00:00Z',yes_bid_dollars:'0.42',yes_ask_dollars:'0.47'}};
const orderbook={orderbook_fp:{yes_dollars:[['0.40','2.00'],['0.42','12.00']],no_dollars:[['0.53','20.00'],['0.55','7.00']]}};
test('Kalshi prices are fixed-point dollars; NO best bid complements YES ask',()=>{
  assert.deepEqual(kalshiBookSummary(orderbook),{status:'OBSERVED',bid:.42,ask:.44999999999999996,midpoint:.43499999999999994,spreadBps:300,depthUsd:Math.min(12*.42,7*.44999999999999996)});
});
test('empty or corrupt Kalshi book never invents a midpoint',()=>{
  assert.equal(kalshiBookSummary({orderbook_fp:{yes_dollars:[],no_dollars:[]}}).status,'EMPTY_BOOK');
  assert.equal(kalshiBookSummary({orderbook_fp:{yes_dollars:[['0.90','2']],no_dollars:[['0.80','2']]}}).status,'CROSSED_BOOK');
});
test('ticker validation prevents user-driven URL path injection and SSRF',()=>{
  assert.equal(validKalshiTicker('KXSOL-26NOV23-YES'),true);
  for(const value of ['http://evil.example','../market','kxsol','KX/ABC','abc?x=1','','A'.repeat(121),null]) assert.equal(validKalshiTicker(value),false);
});
test('observer never sends an API key, never makes write requests and caches by market ticker',async()=>{
  const calls=[];let now=1_700_000_000_000;
  const fetchImpl=async(url,opts)=>{calls.push({url,opts});return response(url.endsWith('/orderbook')?orderbook:market)};
  const observer=new KalshiPublicObserver({fetchImpl,now:()=>now,ttlMs:30000});
  const a=await observer.read(market.market.ticker,{probability:.435});
  assert.equal(a.status,'OBSERVED');assert.equal(a.comparison.status,'SIMILAR');
  assert.equal(a.role,'REFERENCE_ONLY_NOT_AN_EXECUTION_ORACLE');
  assert.equal(calls.length,2);
  assert.ok(calls.every(c=>c.url.startsWith(KALSHI_PUBLIC_PROD+'/markets/')&&c.opts.headers.accept==='application/json'&&!c.opts.method&&!c.opts.headers.authorization));
  await observer.read(market.market.ticker,{probability:.9});
  assert.equal(calls.length,2);assert.equal((await observer.read(market.market.ticker,{probability:.9})).comparison.status,'DIVERGENT');
  now+=30_100; await observer.read(market.market.ticker,{probability:.4});assert.equal(calls.length,4);
});
test('invalid ticker and network errors never provide a substitute trading signal',async()=>{
  let count=0;
  const observer=new KalshiPublicObserver({fetchImpl:async()=>{count++;return response({},502)}});
  const no=await observer.read('../x',{probability:.5});
  assert.equal(no.status,'NO_MATCHED_TICKER');assert.equal(count,0);
  const err=await observer.read(market.market.ticker,{probability:.5});
  assert.equal(err.status,'UNAVAILABLE');assert.equal(err.comparison.status,'NOT_COMPARABLE');
  assert.equal(count,2);
});
test('observer can be disabled without contacting a remote server',async()=>{
  const observer=new KalshiPublicObserver({enabled:false,fetchImpl:async()=>{throw Error('should not be called')}});
  assert.equal((await observer.read(market.market.ticker,{probability:.5})).status,'DISABLED');
});
test('journal excludes other mandates and distinguishes worker logs and receipts',()=>{
  const decisions=[{id:'a',fuseId:'f1',at:200,outcome:'BLOCKED',reason:'ORACLE_STALE',explanation:'Quote stale',targetUsd:25,venueExposureUsd:0},
    {id:'b',fuseId:'f1',at:100,outcome:'HOLD',reason:'NOOP',targetUsd:0,venueExposureUsd:0},
    {id:'c',fuseId:'f2',at:300,outcome:'FILLED',targetUsd:100,venueExposureUsd:100}];
  const receipts=[{fuseId:'f1',hash:'abc123',reason:'INITIAL_OPEN',txSignature:'receipt',createdAt:150,filledExposureAfterUsd:25},
    {fuseId:'f2',hash:'other',reason:'INITIAL_OPEN',createdAt:200}];
  const data=buildDecisionJournal({fuseId:'f1',decisions,receipts});
  assert.deepEqual(data.summary,{decisions:2,riskHolds:1,capturedFills:1,independentlyVerifiedFills:0,latestVenueExposureUsd:0});
  assert.equal(data.entries.length,3);
  assert.equal(data.entries.find(x=>x.kind==='VENUE_RECEIPT').evidence,'CAPTURED_UNVERIFIED');
  assert.equal(data.entries.find(x=>x.id==='a').evidence,'WORKER_LOG_ONLY');
  const verified=buildDecisionJournal({fuseId:'f1',decisions,receipts,verifiedHashes:['abc123']});
  assert.equal(verified.summary.independentlyVerifiedFills,1);
});
test('journal does not present kill requests as confirmed closes',()=>{
  const data=buildDecisionJournal({fuseId:'f1',decisions:[{id:'k',fuseId:'f1',at:10,outcome:'CLOSE_PENDING',reason:'KILL',explanation:'Venue still open'}]});
  assert.equal(data.summary.independentlyVerifiedFills,0);
  assert.equal(data.entries[0].evidence,'WORKER_LOG_ONLY');
  assert.equal(data.entries[0].category,'RISK');
});
test('UI contains read-only market reference and separate journal without trading',()=>{
  const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  const js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
  for (const id of ['marketContextTitle','marketKalshiPrice','marketDflowPrice','journalEvents','journalStats','journalVerified']) assert.ok(html.includes(`id="${id}"`));
  assert.match(html,/only input to the Fuse trading policy/);
  assert.match(js,/api\/market\/context/);
  assert.match(js,/api\/journal/);
  assert.match(js,/SYNTHETIC_FIXTURE/);
});

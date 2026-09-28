import { defaultDemoPolicy } from '../src/core/policy.mjs';
import { replayPolicy } from '../src/core/replay.mjs';
import { stressSizedCap } from '../src/core/risk.mjs';

const policy=defaultDemoPolicy();
const clean=[6100,7200,5400,3200,7600];
console.log('\nKULT FUSE — DETERMINISTIC SIMULATION');
console.log('====================================');
for(const r of replayPolicy(policy,clean)) console.log(`${String(r.i).padStart(2)}  P=${(r.pBps/100).toFixed(1).padStart(5)}%   ${String(r.before).padStart(4)} -> ${String(r.after).padStart(4)}   ${r.reason}`);

const chatter=Array.from({length:20},(_,i)=>i%2?5950:6050);
let chatterTarget=200, turnover=0;
const { hysteresisTarget } = await import('../src/core/policy.mjs');
for (const p of chatter) { const n=hysteresisTarget(policy,p,chatterTarget).targetUsd; turnover+=Math.abs(n-chatterTarget); chatterTarget=n; }
console.log(`\nThreshold chatter turnover with hysteresis (starting in $200 band): $${turnover.toFixed(0)} across 20 observations`);

console.log('\nGap loss reality at $500 notional:');
for(const pct of [3,5,10,15,20]) console.log(`  -${pct}% SOL move => approx -$${(500*pct/100).toFixed(2)}`);
console.log(`\nStress-sized cap for $50 loss budget @15% move: $${stressSizedCap({userCapUsd:500,lossBudgetUsd:50,stressMoveBps:1500}).toFixed(2)}`);

function randn(){let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)}
function monteCarlo(signalStrength=0.2,n=10000){
  let total=0,wins=0;
  for(let path=0;path<n;path++){
    let p=.61,target=0,pnl=0,killed=false;
    for(let t=0;t<48;t++){
      const probabilityShock=randn();
      const dp=.025*probabilityShock;
      p=Math.min(.95,Math.max(.2,p+dp));
      const desired=killed?{after:0,status:'KILLED'}:replayPolicy(policy,[Math.round(p*10000)])[0];
      let nextTarget=desired.after;
      if(desired.status==='KILLED') killed=true;
      const tradingCost=Math.abs(nextTarget-target)*.001;
      // Economic test: probability repricing is allowed to lead the NEXT consequence return.
      const solRet=.015*(signalStrength*probabilityShock+Math.sqrt(Math.max(0,1-signalStrength*signalStrength))*randn());
      pnl+=nextTarget*solRet-tradingCost;
      target=nextTarget;
    }
    total+=pnl;if(pnl>0)wins++;
  }
  return{avg:total/n,winRate:wins/n};
}
console.log('\nSynthetic economic sensitivity (not a return forecast):');
for(const c of [0,.1,.2,.3,.4]){const m=monteCarlo(c);console.log(`  event→SOL signal strength ${c.toFixed(1)} => avg P&L $${m.avg.toFixed(2)}, positive paths ${(m.winRate*100).toFixed(1)}%`)}

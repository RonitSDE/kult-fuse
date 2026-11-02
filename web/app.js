const $ = (s) => document.querySelector(s);
const money = (n, decimals) => {
  const v = Number(n || 0); const d = decimals ?? (Math.abs(v) < 100 ? 2 : 0);
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(d)}`;
};
const short = (h) => h ? `${String(h).slice(0,8)}…${String(h).slice(-8)}` : '—';
const isSignature = (v) => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(v);
const pct = (x, d=1) => Number(x || 0).toFixed(d) + '%';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let state = null;
let proofState = null;
let proofFailed = false;
let toastTimer = null;
let replayMode = false;
let replayTimer = null;
const REPLAY_STEPS = [
  { p: 52, requested: null, kind: 'open', title: 'Open inside the 50% band' },
  { p: 64, requested: null, kind: 'resize', title: 'Step up inside the 60% band' },
  { p: 84, requested: null, kind: 'resize', title: 'Step up inside the 80% band' },
  { p: 29, requested: 0, kind: 'kill', title: 'Probability falls through the kill threshold' },
  { p: 29, requested: 0, kind: 'closed', title: 'Position closed. Mandate locked.' },
  { p: 84, requested: 'overCap', kind: 'rejected', title: 'An over-cap reopen is rejected after kill' }
];

const TOKEN_KEY='kultFuseOperatorToken';
function operatorToken(){try{return sessionStorage.getItem(TOKEN_KEY)||''}catch{return ''}}
function setOperatorToken(t){try{t?sessionStorage.setItem(TOKEN_KEY,t):sessionStorage.removeItem(TOKEN_KEY)}catch{}}

async function api(path, body) {
  const headers={'content-type':'application/json'};
  const token=operatorToken(); if(token) headers.authorization=`Bearer ${token}`;
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

function toast(message, kind='good') {
  const el=$('#toast'); el.textContent=message; el.className=`toast ${kind} show`;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),2600);
}

function currentProbability(fuse) {
  return fuse.lastProbabilityBps > 0 ? fuse.lastProbabilityBps / 100 : null;
}

function rawTarget(policy,pBps){
  let target=0; for(const s of policy.steps){if(pBps>=s.pBps) target=s.exposureUsd; else break;} return Math.min(target,policy.riskCapUsd);
}

function renderCurve(fuse, pBps, force) {
  const el=$('#curve'); if(!el) return; el.innerHTML='';
  const policy=fuse.policy;
  const probability=pBps==null?currentProbability(fuse):pBps/100;
  const bps=pBps==null?(probability==null?null:Math.round(probability*100)):pBps;
  const killed=Boolean(force?.killed) || (bps!=null && bps<policy.killBelowBps);
  const permitted=force && Object.hasOwn(force,'permitted') ? force.permitted : (bps==null?fuse.desiredExposureUsd:(killed?0:rawTarget(policy,bps)));
  const kill=document.createElement('div');
  kill.className=`curve-step kill-step ${killed?'active':''}`;
  kill.style.setProperty('--h','8%');
  kill.innerHTML=`<span>&lt; ${(policy.killBelowBps/100).toFixed(0)}% probability</span><b>KILL · $0</b>`;
  el.appendChild(kill);
  for (const s of policy.steps) {
    const active=!killed && permitted===s.exposureUsd && bps!=null && bps>=s.pBps;
    const d=document.createElement('div'); d.className=`curve-step ${active?'active':''}`;
    const h=Math.max(12,Math.round(s.exposureUsd/policy.riskCapUsd*100));
    d.style.setProperty('--h',`${h}%`);
    d.innerHTML=`<span>≥ ${(s.pBps/100).toFixed(0)}%</span><b>${money(s.exposureUsd)}</b>`;
    el.appendChild(d);
  }
  if($('#curveNowP')) $('#curveNowP').textContent=bps==null?'—':pct(bps/100);
  if($('#curveNowE')) $('#curveNowE').textContent=bps==null?'—':money(permitted,0);
  const needle=$('#curveNeedle');
  if(needle && bps!=null){ needle.style.left=`${Math.max(0,Math.min(100,bps/100))}%`; }
  if($('#curveNeedleLabel') && bps!=null){
    $('#curveNeedleLabel').textContent=pct(bps/100);
    $('#curveNeedleLabel').style.left=`${Math.max(2,Math.min(92,bps/100))}%`;
  }
  return { bps, permitted, killed };
}

function explorerUrl(kind,value,network){
  const net=network||state?.integrity?.network||'devnet';
  return `https://solscan.io/${kind}/${encodeURIComponent(value)}${net==='mainnet-beta'?'':`?cluster=${encodeURIComponent(net)}`}`;
}

function receiptTxLink(r){
  const links=[];
  if(isSignature(r.txSignature)) links.push(`<a href="${explorerUrl('tx',r.txSignature,r.venueCluster)}" target="_blank" rel="noreferrer">VENUE TX ↗</a>`);
  const anchored=r.chain?.txs?.filter(t=>t.ix==='record_fill').at(-1)||r.chain?.txs?.at(-1);
  if(anchored) links.push(`<a href="${explorerUrl('tx',anchored.signature)}" target="_blank" rel="noreferrer">ON-CHAIN ↗</a>`);
  return links.join(' ');
}

function renderLiveChainProof(f,integrity={}){
  if(!integrity.onchain) return;
  if(integrity.fusePda) setProofLink('#proofPda',{value:integrity.fusePda,url:explorerUrl('account',integrity.fusePda)});
  const kill=(f.chainTxs||[]).filter(t=>t.ix.startsWith('trigger_')).at(-1);
  if(kill) setProofLink('#proofKillTx',{value:kill.signature,url:explorerUrl('tx',kill.signature)});
}

function renderReceipts(receipts=[]) {
  $('#receiptCount').textContent=`${receipts.length} RECEIPT${receipts.length===1?'':'S'}`;
  const verified=Boolean(proofState?.verifiedRun?.source==='live' && receipts.length && proofState.verifiedRun.receipts.length===receipts.length && receipts.every((r,i)=>r.hash===proofState.verifiedRun.receipts[i]?.hash));
  $('#proofReceiptCopy').textContent=verified?`${receipts.length} independently verified fill${receipts.length===1?'':'s'}`:receipts.length?`${receipts.length} receipt${receipts.length===1?'':'s'}; run the verifier`:'No fill to verify yet';
  $('#proofReceipts').className=`proof-icon ${verified?'':'muted'}`; $('#proofReceipts').textContent=verified?'✓':'·';
  const el=$('#receipts');
  if(!receipts.length){el.className='receipts empty';el.textContent='No execution receipts yet.';return;}
  el.className='receipts';el.innerHTML='';
  [...receipts].reverse().slice(0,14).forEach(r=>{
    const delta=Number(r.filledExposureAfterUsd)-Number(r.actualExposureBeforeUsd);
    const d=document.createElement('div');d.className='receipt';
    const deltaClass=r.reason==='KILL_PROBABILITY'||r.reason==='EMERGENCY_KILL'?'kill':delta>=0?'up':'down';
    d.innerHTML=`<div><b>${r.reason.replaceAll('_',' ')}</b><small>P ${(r.observedProbabilityBps/100).toFixed(1)}% · target ${money(r.desiredExposureAfterUsd)} · actual ${money(r.filledExposureAfterUsd)}</small><code>${short(r.hash)}</code>${receiptTxLink(r)}${r.txSignature?`<small class="${r.anchor?.status==='ANCHORED'?'':'warn'}">${r.anchor?.status==='ANCHORED'?'anchored onchain':'UNVERIFIED · not anchored'}</small>`:''}</div><div class="delta ${deltaClass}">${delta>=0?'+':''}${money(delta)}</div>`;
    el.appendChild(d);
  });
}

function setFlowActive(id,on=true){$(id)?.classList.toggle('active',on)}

function renderDecisions(decisions=[]){
  const root=$('#decisionJournal'); if(!root) return;
  root.replaceChildren();
  if(!decisions.length){root.textContent='No worker decisions recorded for this mandate.';return;}
  for(const entry of [...decisions].reverse().slice(0,6)){
    const row=document.createElement('div'); row.className='decision-entry';
    const head=document.createElement('div'); head.className='decision-entry-head';
    const outcome=document.createElement('strong');outcome.textContent=String(entry.outcome||'UNKNOWN').replaceAll('_',' ');
    outcome.dataset.outcome=entry.outcome||'UNKNOWN';
    const time=document.createElement('time');time.textContent=`${new Date(entry.at).toLocaleTimeString()}${entry.repeatCount>1?` · ×${entry.repeatCount}`:''}`;
    head.append(outcome,time);
    const detail=document.createElement('p');detail.textContent=entry.explanation||'No new execution.';
    const meta=document.createElement('small');
    const actual=entry.venueExposureUsd==null?'unavailable':money(entry.venueExposureUsd);
    meta.textContent=`${entry.reason||'—'} · target ${money(entry.targetUsd)} · venue ${actual} · worker log only`;
    row.append(head,detail,meta);
    if(isSignature(entry.venueSignature)){
      const link=document.createElement('a');link.href=explorerUrl('tx',entry.venueSignature,state?.position?.cluster);
      link.target='_blank';link.rel='noreferrer';link.textContent='Venue tx · verify separately ↗';row.append(link);
    }
    root.append(row);
  }
}

function setProofLink(selector, item) {
  const el=$(selector); if(!el) return;
  el.classList.remove('proof-live','proof-loading','proof-missing');
  if(!proofState && !proofFailed){
    el.textContent='Fetching Solana proof…'; el.classList.add('proof-loading'); el.removeAttribute('href'); return;
  }
  if(proofFailed){
    el.textContent='Proof request failed'; el.classList.add('proof-missing'); el.removeAttribute('href'); return;
  }
  if(item?.value && item?.url){el.textContent=short(item.value);el.href=item.url;el.classList.add('proof-live'); return;}
  el.textContent='No transaction on this mandate yet'; el.classList.add('proof-missing'); el.removeAttribute('href');
}

function showFeatured({prob,permitted,requested,actual,cap,nonce,hash,hashLabel,tx,verdict,raw}){
  $('#rfProb').textContent=prob;
  $('#rfPermitted').textContent=permitted;
  $('#rfRequested').textContent=requested;
  $('#rfActual').textContent=actual;
  $('#rfCap').textContent=cap;
  $('#rfNonce').textContent=nonce;
  $('#rfHashLabel').textContent=hashLabel||'RECEIPT HASH';
  $('#rfHash').textContent=hash||'—';
  const verdictEl=$('#receiptVerdict');
  verdictEl.textContent=verdict;
  verdictEl.className=`receipt-verdict ${verdict==='REJECTED'?'bad':verdict==='PASS'?'good':''}`;
  const link=$('#rfTx');
  link.classList.remove('proof-live','proof-loading','proof-missing');
  if(tx?.value && tx?.url){ link.textContent=short(tx.value); link.href=tx.url; link.classList.add('proof-live'); }
  else if(!proofState && !proofFailed){ link.textContent='Fetching Solana proof…'; link.removeAttribute('href'); link.classList.add('proof-loading'); }
  else if(proofFailed){ link.textContent='Proof request failed'; link.removeAttribute('href'); link.classList.add('proof-missing'); }
  else { link.textContent='No transaction on this mandate yet'; link.removeAttribute('href'); link.classList.add('proof-missing'); }
  $('#rfRaw').textContent=raw||'No raw receipt yet.';
}

function renderIntegrity(integrity={}) {
  const live=Boolean(integrity.onchain);
  const label=`${String(integrity.network||'devnet').toUpperCase()} LIVE`;
  $('#integrityLabel').textContent=label; $('#integrityLabel').className=`proof-dot ${live?'proof-live':'proof-local'}`;
  $('#chainProofMode').textContent=label;
  $('#networkLabel').textContent=`${String(integrity.network||'devnet').toUpperCase()} · ${String(integrity.perpAdapter||'').toUpperCase()}`;
  $('#venueLabel').textContent=String(integrity.perpAdapter||'drift').toLowerCase()==='flash'?'Flash Trade':String(integrity.perpAdapter||'drift').toUpperCase();
  $('#eventSourceLabel').textContent=integrity.eventSource==='dflow'?'DFlow / Kalshi':'Polymarket';
  $('#proofBuild').textContent=`${integrity.buildTag||'dev'} · ${short(integrity.buildSha)}`;
}

async function loadProof(){
  try{
    proofFailed=false;
    proofState=await api('/api/proof');
    setProofLink('#proofProgram',proofState.program);
    setProofLink('#proofPda',proofState.fuseAccount);
    setProofLink('#proofTarget',proofState.transactions?.target);
    setProofLink('#proofKillTx',proofState.transactions?.kill);
    setProofLink('#proofVenueOpen',proofState.transactions?.venueOpen);
    setProofLink('#proofVenueResize',proofState.transactions?.venueResize);
    setProofLink('#proofVenueClose',proofState.transactions?.venueClose);
    const verified=proofState.verifiedRun;
    const ready=Boolean(verified?.receipts?.length && verified.receipts.every(r=>r?.hash && isSignature(r?.txSignature)));
    $('#verifiedReplayBtn')?.classList.toggle('hidden',!ready);
    if(ready && !replayTimer) $('#verifiedReplayBtn').textContent=verified.source==='live'?'VERIFIED REPLAY':'RECORDED REPLAY';
    renderIntegrity(proofState.integrity||{});
    if(state && !replayMode) render(state);
  }catch{
    proofFailed=true;
    $('#verifiedReplayBtn')?.classList.add('hidden');
    for (const id of ['#proofProgram','#proofPda','#proofTarget','#proofKillTx','#proofVenueOpen','#proofVenueResize','#proofVenueClose']) setProofLink(id,null);
  }
}


function render(s) {
  state=s; const f=s.fuse,p=s.position,receipts=s.receipts||[], sig=f.lastSignal;
  const pDisplay=currentProbability(f);
  $('#statusBadge').textContent=f.status; $('#statusBadge').className=`status-pill ${f.status.toLowerCase()}`;
  renderIntegrity(s.integrity||{});
  renderMarket(s.market);
  $('#policyHash').textContent=f.policyHash;
  $('#probability').textContent=pDisplay==null?'—':pct(pDisplay); $('#flowP').textContent=pDisplay==null?'—':pct(pDisplay);
  $('#probDial').style.setProperty('--p',Math.max(0,Math.min(100,pDisplay??0)));
  $('#target').textContent=money(f.desiredExposureUsd); $('#flowTarget').textContent=money(f.desiredExposureUsd);
  $('#filled').textContent=money(p.exposureUsd); $('#flowFilled').textContent=money(p.exposureUsd);
  if($('#perpSide')) $('#perpSide').textContent=`SOL-PERP ${(p.side||'long').toUpperCase()}`;
  $('#cap').textContent=money(f.policy.riskCapUsd); $('#capHero').textContent=money(f.policy.riskCapUsd);
  $('#kill').textContent=`<${(f.policy.killBelowBps/100).toFixed(0)}%`; $('#killHero').textContent=`<${(f.policy.killBelowBps/100).toFixed(0)}%`;
  $('#markPrice').textContent=p.markPrice?money(p.markPrice,2):'—';
  $('#pnl').textContent=p.unrealizedPnlUsd==null?'—':money(p.unrealizedPnlUsd,2);
  const stop=Number(f.policy?.lossStopUsd||0);
  if($('#lossStopNote')) {
    $('#lossStopNote').classList.toggle('hidden',!f.lossStop?.closeTxSignature);
    $('#lossStopNote').textContent=stop>0?`Observed venue P&L triggered a close at −$${stop}. Execution price and final loss can differ; Fuse does not calculate P&L.`:'';
  }
  const ls=f.lossStop, lsEl=$('#lossStopEvidence');
  if(lsEl){
    lsEl.classList.toggle('hidden',!ls);
    if(ls) lsEl.innerHTML=`<b>Loss stop fired</b> ${new Date(ls.triggeredAt).toLocaleString()} at P&amp;L ${money(ls.triggerPnlUsd,2)} (trigger ${money(ls.thresholdUsd,2)}) on ${money(ls.positionUsd)}. Close receipt <code>${short(ls.closeReceiptHash)}</code> · ${isSignature(ls.closeTxSignature)?`<a target="_blank" rel="noreferrer" href="${explorerUrl('tx',ls.closeTxSignature,p.cluster)}">close tx ${short(ls.closeTxSignature)}</a>`:'no close transaction recorded'} · residual ${money(ls.residualUsd)}.`;
  }
  const va=s.integrity?.venueAuthority;
  if($('#authorityNote')&&va) $('#authorityNote').textContent=va.bound?'Venue authority verified as bound by the deployed program.':`Venue authority not bound. ${va.limitation}`;
  if($('#authorityHero')) $('#authorityHero').textContent=va?.bound?'BOUND':'UNBOUND';
  if($('#trustBoundaryCopy')&&va) $('#trustBoundaryCopy').textContent=va.limitation;
  const q=s.quote;
  if($('#liveQuote')){
    if(q?.bid!=null && q?.ask!=null){
      const mid=((Number(q.bid)+Number(q.ask))/2)*100;
      $('#liveQuote').textContent=`${q.question||'Polymarket'}: ${mid.toFixed(1)}% · bid ${(Number(q.bid)*100).toFixed(1)}% · ask ${(Number(q.ask)*100).toFixed(1)}% · spread ${q.spreadBps} bps · ${Number(q.ageSec).toFixed(0)}s old`;
    }else $('#liveQuote').textContent='No current Polymarket quote. Risk increases are on hold.';
  }
  $('#lastSync').textContent=`Backend synchronized ${new Date().toLocaleTimeString()} · ${s.integrity?.network||'unknown cluster'}`;
  $('#clusterLabel').textContent=String(s.integrity?.network||'—').toUpperCase();
  const actualUsd=Math.abs(Number(p.exposureUsd||0));
  let action='HOLD',detail='Waiting for a usable quote and armed mandate.',tone='hold';
  if(f.status==='KILLED') {
    action=actualUsd>=0.01?'CLOSE PENDING':'KILLED · FLAT'; tone=actualUsd>=0.01?'danger':'hold';
    detail=actualUsd>=0.01?`Fuse is killed but ${money(actualUsd)} remains on the venue. A separate close must confirm.`:'The venue reports zero exposure. This mandate cannot reopen through Fuse.';
  } else if(!['ARMED','OPEN','REDUCING'].includes(f.status)) {
    detail=f.status==='PROPOSED'?'The operator must arm the committed policy before the worker can trade.':'This mandate has settled.';
  } else if(!q || !q.quality) {
    detail=q?`${q.qualityReason} quote: no new risk increase. Existing venue exposure is ${money(actualUsd)}.`:'Quote unavailable: no new risk increase.';
  } else if(Number(f.desiredExposureUsd)>Number(p.exposureUsd)+Number(f.policy.minRebalanceUsd||0)) {
    action='INCREASE REQUESTED';tone='active';detail='The committed curve permits this target. Check the venue fill separately.';
  } else if(Number(f.desiredExposureUsd)<Number(p.exposureUsd)-Number(f.policy.minRebalanceUsd||0)) {
    action='REDUCE REQUESTED';tone='warn';detail='The venue position is above the target. A reduction still needs a venue fill.';
  } else {
    action='WITHIN TARGET';tone='active';detail='The actual venue position is near the current target. Inspect receipts for execution proof.';
  }
  $('#decisionTitle').textContent=action;$('#decisionDetail').textContent=detail;
  $('#decisionPermitted').textContent=money(f.desiredExposureUsd);$('#decisionActual').textContent=money(p.exposureUsd);
  $('#decisionIcon').textContent=tone==='danger'?'!':tone==='active'?'↗':'·';
  $('.decision-panel').dataset.tone=tone;
  $('#reason').textContent=(f.lastReasonCode||'NOOP').replaceAll('_',' '); $('#receiptHash').textContent=short(f.policyHash);
  $('#expectedTarget').textContent=money(f.status==='KILLED'||pDisplay==null?0:rawTarget(f.policy,Math.round(pDisplay*100)));
  $('#policyResult').textContent=Math.abs(f.desiredExposureUsd)>f.policy.riskCapUsd?'VIOLATION':f.status==='PROPOSED'?'NOT ARMED':!q?.quality?'NO INCREASE':'TARGET IN BOUNDS';
  $('#policyResult').className=Math.abs(f.desiredExposureUsd)<=f.policy.riskCapUsd&&q?.quality?'green':'';
  const util=Math.min(100,Math.abs(Number(p.exposureUsd||0))/f.policy.riskCapUsd*100); $('#riskBar').style.width=`${util}%`; $('#riskUtil').textContent=`${util.toFixed(0)}%`;
  const op=Boolean(operatorToken()), active=['ARMED','OPEN','REDUCING'].includes(f.status);
  $('#armBtn').disabled=!op||f.status!=='PROPOSED';
  $('#tickBtn').disabled=!op||!active;
  $('#emergencyKillBtn').disabled=!op||['PROPOSED','KILLED','SETTLED'].includes(f.status);
  $('#settleBtn').disabled=!op||!['KILLED','ARMED','OPEN','REDUCING'].includes(f.status)||Math.abs(Number(p.exposureUsd||0))>=0.01;
  $('#newFuseBtn').disabled=!op||!['KILLED','SETTLED'].includes(f.status);
  $('#operatorBtn').textContent=op?'Operator · signed in':'Operator';

  // The latest quote wins over the worker's last accepted tick, so a frozen feed shows its real age.
  const book=q?.bid!=null?q:sig;
  $('#quoteAge').textContent=book?.ageSec==null?'—':`${Number(book.ageSec).toFixed(0)}s`;
  $('#quoteDepth').textContent=book?.depthUsd==null?'—':money(book.depthUsd,0);
  $('#signalExplain').textContent=book?.explain||'Waiting for a quote.';
  if(book){
    $('#bid').textContent=pct(book.bid*100); $('#ask').textContent=pct(book.ask*100); $('#spread').textContent=book.spreadBps==null?'—':`${book.spreadBps} bps`; $('#sequence').textContent=f.oracleSequence;
    $('#signalQuality').textContent=book.quality?'USABLE SIGNAL':`${book.qualityReason} — NO INCREASE`;
    $('#signalQuality').style.color=book.quality?'var(--lime)':'var(--amber)';
    $('#flowSource').textContent=String(book.source||'EVENT SOURCE').split(':')[0].toUpperCase();
  }else{
    $('#bid').textContent='—';$('#ask').textContent='—';$('#spread').textContent='—';$('#sequence').textContent=f.oracleSequence||0;$('#signalQuality').textContent='AWAITING SIGNAL';$('#flowSource').textContent=String(s.integrity?.eventSource||'').toUpperCase();
  }
  const runVerified=Boolean(proofState?.verifiedRun?.source==='live' && receipts.length && proofState.verifiedRun.receipts.length===receipts.length && receipts.every((r,i)=>r.hash===proofState.verifiedRun.receipts[i]?.hash));
  $('#flowProofText').textContent=runVerified?'VERIFIED':receipts.length?'CHECK FILLS':'NO FILLS';
  setFlowActive('#flowSignal',Boolean(q?.quality));setFlowActive('#flowPolicy',f.desiredExposureUsd!==0||f.status==='KILLED');setFlowActive('#flowPosition',Math.abs(Number(p.exposureUsd||0))>0||f.status==='KILLED');setFlowActive('#flowProof',runVerified);
  const onchainKill=f.status==='KILLED'&&(f.chainTxs||[]).some(t=>String(t.ix).startsWith('trigger_')&&isSignature(t.signature));
  $('#proofKill').textContent=onchainKill?'✓':'·'; $('#proofKill').className=`proof-icon ${onchainKill?'':'muted'}`;
  const committed=(f.chainTxs||[]).some(t=>t.ix==='init_fuse'&&isSignature(t.signature));
  $('#proofCommit').textContent=committed?'✓':'·'; $('#proofCommit').className=`proof-icon ${committed?'':'muted'}`;
  const targetProven=(f.chainTxs||[]).some(t=>t.ix==='set_target'&&isSignature(t.signature));
  $('#proofCurve').textContent=targetProven?'✓':'·'; $('#proofCurve').className=`proof-icon ${targetProven?'':'muted'}`;
  const curve=renderCurve(f);
  const latest=receipts.at(-1);
  if(!replayMode){
    const steps=f.policy.steps||[];
    const example=steps.length>1?`${pct(steps[0].pBps/100)} permits ${money(steps[0].exposureUsd)}; ${pct(steps[1].pBps/100)} permits ${money(steps[1].exposureUsd)}.`:'The user commits an exposure rule before execution.';
    $('#heroExample').textContent=`${example} The quote proposes a target on ${f.policy.marketId||'the selected perp'}. Fuse checks the target; verify a venue fill separately. The worker's venue key is ${va?.bound?'bound to the policy':'not yet bound'}.`;
    $('#heroMarket').textContent=s.market?.question?`Committed market · ${s.market.question}`:'Committed market loading…';
    if(latest){
      showFeatured({
        prob:pct(latest.observedProbabilityBps/100),
        permitted:money(latest.desiredExposureAfterUsd),
        requested:money(latest.desiredExposureAfterUsd),
        actual:money(latest.filledExposureAfterUsd),
        cap:money(f.policy.riskCapUsd),
        nonce:String(latest.sequence),
        hash:latest.hash,
        tx:isSignature(latest.txSignature)?{value:latest.txSignature,url:explorerUrl('tx',latest.txSignature,latest.venueCluster)}:null,
        verdict:proofState?.verifiedRun?.source==='live'&&proofState.verifiedRun.receipts.some(r=>r.hash===latest.hash)?'PASS':'WAITING',
        raw:JSON.stringify(latest,null,2)
      });
    }else if(curve){
      showFeatured({
        prob:curve.bps==null?'—':pct(curve.bps/100),
        permitted:money(curve.permitted),
        requested:money(curve.permitted),
        actual:money(p.exposureUsd),
        cap:money(f.policy.riskCapUsd),
        nonce:f.executionNonce?String(f.executionNonce):'—',
        hash:f.lastReceiptHash||f.policyHash,
        hashLabel:f.lastReceiptHash?'RECEIPT HASH':'POLICY HASH',
        tx:null,
        verdict:'WAITING',
        raw:f.lastReceiptHash?`policy ${f.policyHash}\nreceipt head ${f.lastReceiptHash}`:`policy ${f.policyHash}`
      });
    }
  }
  renderReceipts(receipts);renderDecisions(s.decisions||[]);renderLiveChainProof(f,s.integrity);
}

function applyReplayStep(step,index){
  const f=state.fuse;
  const bps=Math.round(step.p*100);
  const killed=step.kind==='kill'||step.kind==='closed'||step.kind==='rejected';
  const permitted=killed?0:rawTarget(f.policy,bps);
  const requested=step.requested==='overCap'?f.policy.riskCapUsd+10:step.requested==null?permitted:step.requested;
  const actual=step.kind==='rejected'||step.kind==='closed'||step.kind==='kill'?0:permitted;
  const rejected=step.kind==='rejected'||(requested>permitted);
  renderCurve(f,bps,killed?{killed:true,permitted:0}:undefined);
  $('#curveMode').textContent=`SIMULATION ${index+1}/${REPLAY_STEPS.length}`;
  $('#curveNote').textContent=step.title;
  $('#probability').textContent=pct(step.p);
  $('#flowP').textContent=pct(step.p);
  $('#probDial').style.setProperty('--p',step.p);
  $('#target').textContent=money(permitted);
  $('#flowTarget').textContent=money(permitted);
  $('#filled').textContent=money(actual);
  $('#flowFilled').textContent=money(actual);
  $('#expectedTarget').textContent=money(permitted);
  $('#policyResult').textContent=rejected?'REJECTED':'PASS';
  $('#policyResult').className=rejected?'':'green';
  $('#statusBadge').textContent=step.kind==='rejected'?'REJECTED':killed?'KILLED':'OPEN';
  $('#statusBadge').className=`status-pill ${killed?'killed':'open'}`;
  const killEl=$('#killMoment');
  killEl.classList.toggle('hidden',!killed);
  $('#killMomentTitle').textContent=step.kind==='rejected'
    ?'Simulation: killed mandate rejects a reopen.'
    :'Simulation: killed mandate requests a close.';
  $('#rejectLine').classList.toggle('hidden',step.kind!=='rejected');
  if(step.kind==='rejected') $('#rejectLine').textContent=`Simulation: the agent requests ${money(requested)}. The killed mandate refuses a reopen; permitted exposure remains $0.`;
  const tx=null; // A paper story never borrows a real explorer link.
  showFeatured({
    prob:pct(step.p),
    permitted:money(permitted,0),
    requested:money(requested,0),
    actual:money(actual,0),
    cap:money(f.policy.riskCapUsd,0),
    nonce:String(index+1),
    hash:f.policyHash,
    hashLabel:'POLICY HASH',
    tx,
    verdict:rejected?'REJECTED':'SIMULATION',
    raw:JSON.stringify({mode:'simulation',step:index+1,probability:step.p,permittedUsd:permitted,requestedUsd:requested,actualUsd:actual,riskCapUsd:f.policy.riskCapUsd,policyHash:f.policyHash,solana:tx?.value||null,verdict:rejected?'REJECTED':'SIMULATION'},null,2)
  });
  $('#featuredReceipt').scrollIntoView({behavior:'smooth',block:'nearest'});
}

function stopReplay(){
  replayMode=false;
  clearInterval(replayTimer);
  replayTimer=null;
  $('#killMoment')?.classList.add('hidden');
  $('#curveMode').textContent='LIVE POLICY';
  $('#curveNote').textContent='The marker sits on the committed curve. Exposure is the step the program will accept, not a size the agent picks.';
  $('#replayBtn').textContent='SIMULATION';
  if($('#verifiedReplayBtn') && !replayTimer) $('#verifiedReplayBtn').textContent='VERIFIED REPLAY';
  if(state) render(state);
}

function applyVerifiedReceipt(receipt,index,total){
  const f=state.fuse;
  const bps=Number(receipt.observedProbabilityBps);
  const permitted=Number(receipt.desiredExposureAfterUsd);
  const actual=Number(receipt.filledExposureAfterUsd);
  const killed=permitted===0;
  renderCurve(f,bps,killed?{killed:true,permitted:0}:undefined);
  $('#curveMode').textContent=`VERIFIED REPLAY ${index+1}/${total}`;
  $('#curveNote').textContent=String(receipt.reason||'RECEIPT').replaceAll('_',' ');
  $('#probability').textContent=pct(bps/100);
  $('#flowP').textContent=pct(bps/100);
  $('#target').textContent=money(permitted,0);
  $('#filled').textContent=money(actual,0);
  $('#policyResult').textContent='PASS';
  $('#policyResult').className='green';
  $('#statusBadge').textContent=killed?'KILLED':'OPEN';
  $('#statusBadge').className=`status-pill ${killed?'killed':'open'}`;
  $('#killMoment').classList.toggle('hidden',!killed);
  $('#rejectLine').classList.add('hidden');
  showFeatured({
    prob:pct(bps/100),
    permitted:money(permitted,0),
    requested:money(permitted,0),
    actual:money(actual,0),
    cap:money(f.policy.riskCapUsd,0),
    nonce:String(receipt.sequence),
    hash:receipt.hash,
    hashLabel:'RECEIPT HASH',
    tx:isSignature(receipt.txSignature)?{value:receipt.txSignature,url:explorerUrl('tx',receipt.txSignature,receipt.venueCluster)}:null,
    verdict:'PASS',
    raw:JSON.stringify(receipt,null,2)
  });
}

function startVerified(){
  const receipts=proofState?.verifiedRun?.receipts||[];
  if(!receipts.length || !receipts.every(r=>r?.hash && isSignature(r?.txSignature))){
    $('#verifiedReplayBtn')?.classList.add('hidden');
    toast('Verified replay needs receipts and transaction signatures','bad');
    return;
  }
  replayMode=true;
  let i=0;
  $('#verifiedReplayBtn').textContent='REPLAYING…';
  applyVerifiedReceipt(receipts[0],0,receipts.length);
  clearInterval(replayTimer);
  replayTimer=setInterval(()=>{
    i+=1;
    if(i>=receipts.length){clearInterval(replayTimer);replayTimer=null;$('#verifiedReplayBtn').textContent='VERIFIED REPLAY';return;}
    applyVerifiedReceipt(receipts[i],i,receipts.length);
  },1600);
}

function startReplay(){
  if(!state?.fuse?.policy){toast('Waiting for the committed policy','bad');return;}
  replayMode=true;
  let i=0;
  $('#replayBtn').textContent='SIMULATING…';
  applyReplayStep(REPLAY_STEPS[0],0);
  clearInterval(replayTimer);
  replayTimer=setInterval(()=>{
    i+=1;
    if(i>=REPLAY_STEPS.length){clearInterval(replayTimer);replayTimer=null;$('#replayBtn').textContent='SIMULATION';return;}
    applyReplayStep(REPLAY_STEPS[i],i);
  },1600);
}

let refreshing=null;
async function refresh(){
  if(refreshing) return refreshing;
  refreshing=(async()=>{
    try{
      const s=await api('/api/state');state=s;
      $('#connectionBanner').classList.add('hidden');
      if(!replayMode)render(s);
      return s;
    }catch(e){
      $('#connectionBanner').classList.remove('hidden');
      $('#lastSync').textContent='Backend unavailable · displayed state may be old';
      throw e;
    }finally{refreshing=null;}
  })();
  return refreshing;
}
async function mutate(path,body,{quiet=false}={}){try{const out=await api(path,body);await refresh();if(!quiet)toast('State updated');return out}catch(e){await refresh().catch(()=>{});toast(e.message,'bad');throw e}}

function renderMarket(m){
  if(!m) return;
  $('#marketQuestion').textContent=m.question||m.id;
  $('#outcomeLabel').textContent=String(m.outcome||'YES').toUpperCase();
  const link=$('#marketLink'); link.textContent=`${state?.quote?.quality?'LIVE':'UNUSABLE'} · ${String(m.kind||'').toUpperCase()}`;
  if(m.url) link.href=m.url; else link.removeAttribute('href');
}

async function tick(){const out=await mutate('/api/tick',{}, {quiet:true});if(out?.reason==='AWAITING_CONFIRMATION')toast(`Signal confirmed ${out.confirmationCount}/${state.fuse.policy.confirmationCount}`);else toast(out?.executed?'Position reconciled':'Observation accepted');return out}

async function runVerifier(){
  try{
    const v=await api('/api/verify',{}); const sec=$('#verifySection'), panel=$('#verifyPanel');
    $('#verifyHeadline').textContent=v.summary; panel.innerHTML='';
    const esc=(t)=>String(t??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    v.checks.forEach(c=>{const d=document.createElement('div');d.className=`verify-check ${c.ok?'ok':'bad'}`;d.innerHTML=`<i>${c.ok?'✓':'✕'}</i><b>${esc(c.name)}</b><small>${esc(String(c.actual).slice(0,60))}</small>`;panel.appendChild(d)});
    // Only a fill that passed every chain check is labelled Verified.
    (v.fills||[]).forEach(fl=>{const d=document.createElement('div');const ok=fl.status==='VERIFIED';d.className=`verify-check ${ok?'ok':'bad'}`;
      d.innerHTML=`<i>${ok?'✓':'!'}</i><b>${ok?'Verified':'Unverified'} · ${esc(fl.reason.replaceAll('_',' '))}</b><small>${money(fl.positionUsd)} · residual ${money(fl.residualUsd)} · ${esc(fl.fuseStatus)} · ${new Date(fl.timestampMs).toLocaleTimeString()}</small>${isSignature(fl.txSignature)?`<a target="_blank" rel="noreferrer" href="${explorerUrl('tx',fl.txSignature,fl.venueCluster)}">venue tx</a>`:''}${isSignature(fl.anchorSignature)?` <a target="_blank" rel="noreferrer" href="${explorerUrl('tx',fl.anchorSignature)}">anchor tx</a>`:''}${fl.problems.length?`<small>${esc(fl.problems.join('; '))}</small>`:''}`;panel.appendChild(d)});
    const ok=v.status==='VERIFIED';
    sec.classList.remove('hidden'); sec.scrollIntoView({behavior:'smooth',block:'center'}); toast(v.summary,ok?'good':v.status==='NO_EXECUTION'?'neutral':'bad'); return v;
  }catch(e){toast(e.message,'bad');throw e}
}

async function operatorLogin(){
  if(operatorToken()){setOperatorToken('');await refresh();return toast('Operator signed out');}
  $('#operatorError').classList.add('hidden');
  $('#operatorDialog').showModal();
  $('#operatorTokenInput').focus();
}

$('#operatorForm').onsubmit=async(e)=>{
  e.preventDefault();
  const input=$('#operatorTokenInput'), error=$('#operatorError');
  setOperatorToken(input.value.trim());
  try{await api('/api/auth',{});input.value='';$('#operatorDialog').close();await refresh();toast('Operator signed in');}
  catch(e){setOperatorToken('');error.textContent=e.message;error.classList.remove('hidden');}
};
$('#cancelOperator').onclick=()=>{$('#operatorTokenInput').value='';$('#operatorDialog').close()};

$('#tickBtn').onclick=()=>tick();
$('#armBtn').onclick=()=>mutate('/api/arm',{});
$('#emergencyKillBtn').onclick=()=>mutate('/api/kill',{}).then(()=>toast('Kill requested. Confirm the chain and venue close.'));
$('#settleBtn').onclick=()=>mutate('/api/settle',{}).then(()=>toast('Fuse settled'));
$('#newFuseBtn').onclick=async()=>{await mutate('/api/fuse/new',{}, {quiet:true});$('#verifySection').classList.add('hidden');await loadProof();toast('New mandate created on-chain')};
$('#operatorBtn').onclick=operatorLogin;
$('#watchLiveBtn').onclick=()=>{stopReplay();$('#marketQuestion').scrollIntoView({behavior:'smooth',block:'center'});};
$('#retryConnection').onclick=()=>refresh().then(()=>loadProof()).catch(e=>toast(e.message,'bad'));
$('#replayBtn').onclick=()=>{if(replayTimer)stopReplay();else startReplay();};
$('#verifiedReplayBtn').onclick=()=>{if(replayTimer)stopReplay();else startVerified();};
$('#verifyBtn2').onclick=runVerifier;$('#closeVerify').onclick=()=>$('#verifySection').classList.add('hidden');

refresh().catch(e=>toast(e.message,'bad'));
loadProof().catch(()=>{});
// The server worker trades continuously; keep the dashboard in step with it.
setInterval(()=>{if(!document.hidden)refresh().catch(()=>{});},5000);

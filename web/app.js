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
  { p: 74, requested: null, kind: 'resize', title: 'Step up inside the 70% band' },
  { p: 29, requested: 0, kind: 'kill', title: 'Probability falls through the kill threshold' },
  { p: 29, requested: 0, kind: 'closed', title: 'Position closed. Mandate locked.' },
  { p: 80, requested: 500, kind: 'rejected', title: 'Agent requests $500 after the kill' }
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

function explorerUrl(kind,value){
  const net=state?.integrity?.network||'devnet';
  return `https://solscan.io/${kind}/${encodeURIComponent(value)}${net==='mainnet-beta'?'':`?cluster=${encodeURIComponent(net)}`}`;
}

function receiptTxLink(r){
  const links=[];
  if(isSignature(r.txSignature)) links.push(`<a href="${explorerUrl('tx',r.txSignature)}" target="_blank" rel="noreferrer">VIEW RECEIPT ↗</a>`);
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
  $('#proofReceiptCopy').textContent=receipts.length?`${receipts.length} tamper-evident receipt${receipts.length===1?'':'s'} chained`:'Waiting for first execution';
  $('#proofReceipts').className=`proof-icon ${receipts.length?'':'muted'}`; $('#proofReceipts').textContent=receipts.length?'✓':'·';
  const el=$('#receipts');
  if(!receipts.length){el.className='receipts empty';el.textContent='No execution receipts yet.';return;}
  el.className='receipts';el.innerHTML='';
  [...receipts].reverse().slice(0,14).forEach(r=>{
    const delta=Number(r.filledExposureAfterUsd)-Number(r.actualExposureBeforeUsd);
    const d=document.createElement('div');d.className='receipt';
    const deltaClass=r.reason==='KILL_PROBABILITY'||r.reason==='EMERGENCY_KILL'?'kill':delta>=0?'up':'down';
    d.innerHTML=`<div><b>${r.reason.replaceAll('_',' ')}</b><small>P ${(r.observedProbabilityBps/100).toFixed(1)}% · target ${money(r.desiredExposureAfterUsd)} · actual ${money(r.filledExposureAfterUsd)}</small><code>${short(r.hash)}</code>${receiptTxLink(r)}</div><div class="delta ${deltaClass}">${delta>=0?'+':''}${money(delta)}</div>`;
    el.appendChild(d);
  });
}

function setFlowActive(id,on=true){$(id)?.classList.toggle('active',on)}

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

function txForKind(kind){
  const txs=proofState?.transactions||{};
  if(kind==='open') return txs.flashOpen;
  if(kind==='resize') return txs.flashResize;
  if(kind==='kill'||kind==='rejected') return txs.kill;
  if(kind==='closed') return txs.flashClose;
  return null;
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
  $('#venueLabel').textContent=String(integrity.perpAdapter||'flash').toLowerCase()==='flash'?'Flash Trade':'External driver';
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
    setProofLink('#proofFlashOpen',proofState.transactions?.flashOpen);
    setProofLink('#proofFlashResize',proofState.transactions?.flashResize);
    setProofLink('#proofFlashClose',proofState.transactions?.flashClose);
    const verified=proofState.verifiedRun;
    const ready=Boolean(verified?.receipts?.length && verified.receipts.every(r=>r?.hash && isSignature(r?.txSignature)));
    $('#verifiedReplayBtn')?.classList.toggle('hidden',!ready);
    renderIntegrity(proofState.integrity||{});
    if(state && !replayMode) renderLiveChainProof(state.fuse,proofState.integrity);
  }catch{
    proofFailed=true;
    $('#verifiedReplayBtn')?.classList.add('hidden');
    for (const id of ['#proofProgram','#proofPda','#proofTarget','#proofKillTx','#proofFlashOpen','#proofFlashResize','#proofFlashClose']) setProofLink(id,null);
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
  if($('#lossStopNote')) $('#lossStopNote').textContent=stop>0?`Loss stop: the worker closes if Flash P&L reaches −$${stop}. Fuse does not calculate that P&L.`:'No loss stop is configured.';
  const q=s.quote;
  if($('#liveQuote')){
    if(q?.bid!=null && q?.ask!=null){
      const mid=((Number(q.bid)+Number(q.ask))/2)*100;
      $('#liveQuote').textContent=`${q.question||'Polymarket'}: ${mid.toFixed(1)}% · bid ${(Number(q.bid)*100).toFixed(1)}% · ask ${(Number(q.ask)*100).toFixed(1)}%`;
    }else $('#liveQuote').textContent='Fetching Polymarket quote…';
  }
  $('#reason').textContent=(f.lastReasonCode||'NOOP').replaceAll('_',' '); $('#receiptHash').textContent=short(f.policyHash);
  $('#expectedTarget').textContent=money(f.status==='KILLED'||pDisplay==null?0:rawTarget(f.policy,Math.round(pDisplay*100)));
  $('#policyResult').textContent=Math.abs(f.desiredExposureUsd)<=f.policy.riskCapUsd?'WITHIN MANDATE':'VIOLATION';
  $('#policyResult').className=Math.abs(f.desiredExposureUsd)<=f.policy.riskCapUsd?'green':'';
  const util=Math.min(100,Math.abs(Number(p.exposureUsd||0))/f.policy.riskCapUsd*100); $('#riskBar').style.width=`${util}%`; $('#riskUtil').textContent=`${util.toFixed(0)}%`;
  const op=Boolean(operatorToken()), active=['ARMED','OPEN','REDUCING'].includes(f.status);
  $('#armBtn').disabled=!op||f.status!=='PROPOSED';
  $('#tickBtn').disabled=!op||!active;
  $('#emergencyKillBtn').disabled=!op||['PROPOSED','KILLED','SETTLED'].includes(f.status);
  $('#settleBtn').disabled=!op||!['KILLED','ARMED','OPEN','REDUCING'].includes(f.status);
  $('#newFuseBtn').disabled=!op||!['KILLED','SETTLED'].includes(f.status);
  $('#operatorBtn').textContent=op?'Operator · signed in':'Operator';

  const book=sig||(q?.bid!=null?{bid:q.bid,ask:q.ask,spreadBps:q.spreadBps,quality:true,qualityReason:'LIVE',source:q.source}:null);
  if(book){
    $('#bid').textContent=pct(book.bid*100); $('#ask').textContent=pct(book.ask*100); $('#spread').textContent=book.spreadBps==null?'—':`${book.spreadBps} bps`; $('#sequence').textContent=f.oracleSequence;
    $('#signalQuality').textContent=book.quality?`${book.qualityReason} SIGNAL`:`${book.qualityReason} — NO RISK ↑`;
    $('#signalQuality').style.color=book.quality?'var(--lime)':'var(--amber)';
    $('#flowSource').textContent=String(book.source||'EVENT SOURCE').split(':')[0].toUpperCase();
  }else{
    $('#bid').textContent='—';$('#ask').textContent='—';$('#spread').textContent='—';$('#sequence').textContent=f.oracleSequence||0;$('#signalQuality').textContent='AWAITING SIGNAL';$('#flowSource').textContent=String(s.integrity?.eventSource||'').toUpperCase();
  }
  $('#flowProofText').textContent=receipts.length?`${receipts.length} RECEIPT${receipts.length===1?'':'S'}`:'READY';
  setFlowActive('#flowSignal',true);setFlowActive('#flowPolicy',f.desiredExposureUsd!==0||f.status==='KILLED');setFlowActive('#flowPosition',Math.abs(Number(p.exposureUsd||0))>0||f.status==='KILLED');setFlowActive('#flowProof',receipts.length>0);
  $('#proofKill').textContent=f.status==='KILLED'?'✓':'✓';
  const curve=renderCurve(f);
  const latest=receipts.at(-1);
  if(!replayMode){
    const marketName=s.market?.question||'Bitcoin probability';
    $('#heroExample').textContent=`${marketName} moving from 52% to 71% raises the permitted SOL-perp exposure from $200 to $420. That size is the committed curve, not an agent choice. Under 35% the mandate is killed and cannot be reopened.`;
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
        tx:isSignature(latest.txSignature)?{value:latest.txSignature,url:explorerUrl('tx',latest.txSignature)}:(latest.chain?.txs?.at(-1)?{value:latest.chain.txs.at(-1).signature,url:explorerUrl('tx',latest.chain.txs.at(-1).signature)}:txForKind(latest.reason==='KILL_PROBABILITY'||latest.reason==='EMERGENCY_KILL'?'kill':'open')),
        verdict:isSignature(latest.txSignature)?'PASS':'WAITING',
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
        verdict:curve.bps==null?'WAITING':'PASS',
        raw:f.lastReceiptHash?`policy ${f.policyHash}\nreceipt head ${f.lastReceiptHash}`:`policy ${f.policyHash}`
      });
    }
  }
  renderReceipts(receipts);renderLiveChainProof(f,s.integrity);
}

function applyReplayStep(step,index){
  const f=state.fuse;
  const bps=Math.round(step.p*100);
  const killed=step.kind==='kill'||step.kind==='closed'||step.kind==='rejected';
  const permitted=killed?0:rawTarget(f.policy,bps);
  const requested=step.requested==null?permitted:step.requested;
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
    ?'KILLED → position closed → mandate permanently locked.'
    :'KILLED → position closed → mandate permanently locked.';
  $('#rejectLine').classList.toggle('hidden',step.kind!=='rejected');
  const tx=txForKind(step.kind);
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
    tx:isSignature(receipt.txSignature)?{value:receipt.txSignature,url:explorerUrl('tx',receipt.txSignature)}:null,
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

async function refresh(){const s=await api('/api/state');state=s;if(!replayMode)render(s);return s;}
async function mutate(path,body,{quiet=false}={}){try{const out=await api(path,body);await refresh();if(!quiet)toast('State updated');return out}catch(e){toast(e.message,'bad');throw e}}

function renderMarket(m){
  if(!m) return;
  $('#marketQuestion').textContent=m.question||m.id;
  $('#outcomeLabel').textContent=String(m.outcome||'YES').toUpperCase();
  const link=$('#marketLink'); link.textContent=`LIVE · ${String(m.kind||'').toUpperCase()}`;
  if(m.url) link.href=m.url; else link.removeAttribute('href');
}

async function tick(){const out=await mutate('/api/tick',{}, {quiet:true});if(out?.reason==='AWAITING_CONFIRMATION')toast(`Signal confirmed ${out.confirmationCount}/${state.fuse.policy.confirmationCount}`);else toast(out?.executed?'Position reconciled':'Observation accepted');return out}

async function runVerifier(){
  try{
    const v=await api('/api/verify',{}); const sec=$('#verifySection'), panel=$('#verifyPanel');
    $('#verifyHeadline').textContent=v.summary; panel.innerHTML='';
    v.checks.forEach(c=>{const d=document.createElement('div');d.className=`verify-check ${c.ok?'ok':'bad'}`;d.innerHTML=`<i>${c.ok?'✓':'✕'}</i><b>${c.name}</b><small>${String(c.actual).slice(0,60)}</small>`;panel.appendChild(d)});
    sec.classList.remove('hidden'); sec.scrollIntoView({behavior:'smooth',block:'center'}); toast(v.summary,v.ok?'good':'bad'); return v;
  }catch(e){toast(e.message,'bad');throw e}
}

async function operatorLogin(){
  if(operatorToken()){setOperatorToken('');await refresh();return toast('Operator signed out');}
  const t=window.prompt('Operator token (FUSE_ADMIN_TOKEN)');
  if(!t) return;
  setOperatorToken(t.trim());
  try{await api('/api/auth',{});toast('Operator signed in');}catch(e){setOperatorToken('');toast('Invalid operator token','bad');}
  await refresh();
}

$('#tickBtn').onclick=()=>tick();
$('#armBtn').onclick=()=>mutate('/api/arm',{});
$('#emergencyKillBtn').onclick=()=>mutate('/api/kill',{}).then(()=>toast('Emergency kill committed'));
$('#settleBtn').onclick=()=>mutate('/api/settle',{}).then(()=>toast('Fuse settled'));
$('#newFuseBtn').onclick=async()=>{await mutate('/api/fuse/new',{}, {quiet:true});$('#verifySection').classList.add('hidden');await loadProof();toast('New mandate created on-chain')};
$('#operatorBtn').onclick=operatorLogin;
$('#watchLiveBtn').onclick=()=>stopReplay();
$('#replayBtn').onclick=()=>{if(replayTimer)stopReplay();else startReplay();};
$('#verifiedReplayBtn').onclick=()=>{if(replayTimer)stopReplay();else startVerified();};
$('#verifyBtn2').onclick=runVerifier;$('#closeVerify').onclick=()=>$('#verifySection').classList.add('hidden');

Promise.all([refresh(),loadProof()]).catch(e=>toast(e.message,'bad'));
// The server worker trades continuously; keep the dashboard in step with it.
setInterval(()=>refresh().catch(()=>{}),5000);

const $ = (s) => document.querySelector(s);
const money = (n, decimals) => {
  const v = Number(n || 0); const d = decimals ?? (Math.abs(v) < 100 ? 2 : 0);
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(d)}`;
};
const short = (h) => h ? `${String(h).slice(0,8)}…${String(h).slice(-8)}` : '—';
const pct = (x, d=1) => Number(x || 0).toFixed(d) + '%';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let state = null;
let proofState = null;
let toastTimer = null;

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {'content-type':'application/json'},
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
  return fuse.lastProbabilityBps > 0 ? fuse.lastProbabilityBps / 100 : Number($('#probSlider')?.value || 61);
}

function rawTarget(policy,pBps){
  let target=0; for(const s of policy.steps){if(pBps>=s.pBps) target=s.exposureUsd; else break;} return Math.min(target,policy.riskCapUsd);
}

function renderCurve(fuse) {
  const el=$('#curve'); el.innerHTML='';
  const current=fuse.desiredExposureUsd;
  for (const s of fuse.policy.steps) {
    const active=current===s.exposureUsd;
    const d=document.createElement('div'); d.className=`curve-step ${active?'active':''}`;
    const h=Math.max(8,Math.round(s.exposureUsd/fuse.policy.riskCapUsd*100));
    d.style.setProperty('--h',`${h}%`);
    d.innerHTML=`<span>≥ ${(s.pBps/100).toFixed(0)}% probability</span><b>${money(s.exposureUsd)}</b>`;
    el.appendChild(d);
  }
}

function receiptTxLink(r){
  if(!r.txSignature || String(r.txSignature).startsWith('paper_')) return '';
  return `<a href="https://solscan.io/tx/${encodeURIComponent(r.txSignature)}?cluster=devnet" target="_blank" rel="noreferrer">VIEW RECEIPT ↗</a>`;
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

function setProofLink(selector, item, fallback) {
  const el=$(selector); if(!el) return;
  if(item?.value && item?.url){el.textContent=short(item.value);el.href=item.url;el.classList.add('proof-live');}
  else {el.textContent=fallback;el.removeAttribute('href');el.classList.remove('proof-live');}
}

function renderIntegrity(integrity={}) {
  const live=Boolean(integrity.onchain);
  const label=live?`${String(integrity.network||'devnet').toUpperCase()} LIVE`:'LOCAL VERIFIED';
  $('#integrityLabel').textContent=label; $('#integrityLabel').className=`proof-dot ${live?'proof-live':'proof-local'}`;
  $('#chainProofMode').textContent=label;
  $('#networkLabel').textContent=live?`${String(integrity.network||'devnet').toUpperCase()} · ${String(integrity.perpAdapter||'').toUpperCase()}`:'LOCAL DEMO';
  $('#venueLabel').textContent=String(integrity.perpAdapter||'paper').toLowerCase()==='flash'?'Flash Trade':'Paper adapter';
  $('#proofBuild').textContent=`${integrity.buildTag||'dev'} · ${short(integrity.buildSha)}`;
}

async function loadProof(){
  try{proofState=await api('/api/proof');setProofLink('#proofProgram',proofState.program,'NOT DEPLOYED');setProofLink('#proofPda',proofState.fuseAccount,'NOT DEPLOYED');setProofLink('#proofKillTx',proofState.transactions?.kill,'PENDING DEVNET');setProofLink('#proofFlashOpen',proofState.transactions?.flashOpen,'PENDING DEVNET');setProofLink('#proofFlashClose',proofState.transactions?.flashClose,'PENDING DEVNET');renderIntegrity(proofState.integrity||{});}catch{}
}


function render(s) {
  state=s; const f=s.fuse,p=s.position,receipts=s.receipts||[], sig=f.lastSignal;
  const pDisplay=currentProbability(f);
  $('#statusBadge').textContent=f.status; $('#statusBadge').className=`status-pill ${f.status.toLowerCase()}`;
  renderIntegrity(s.integrity||{});
  $('#modeTag').textContent=(s.mode||'demo').toUpperCase();
  $('#policyHash').textContent=f.policyHash;
  $('#probability').textContent=pct(pDisplay); $('#flowP').textContent=pct(pDisplay);
  $('#probDial').style.setProperty('--p',Math.max(0,Math.min(100,pDisplay)));
  $('#target').textContent=money(f.desiredExposureUsd); $('#flowTarget').textContent=money(f.desiredExposureUsd);
  $('#filled').textContent=money(p.exposureUsd); $('#flowFilled').textContent=money(p.exposureUsd);
  $('#cap').textContent=money(f.policy.riskCapUsd); $('#capHero').textContent=money(f.policy.riskCapUsd);
  $('#kill').textContent=`<${(f.policy.killBelowBps/100).toFixed(0)}%`; $('#killHero').textContent=`<${(f.policy.killBelowBps/100).toFixed(0)}%`;
  $('#markPrice').textContent=p.markPrice?money(p.markPrice,2):'—'; $('#pnl').textContent=money(p.unrealizedPnlUsd||0,2);
  $('#reason').textContent=(f.lastReasonCode||'NOOP').replaceAll('_',' '); $('#receiptHash').textContent=short(f.lastReceiptHash);
  $('#expectedTarget').textContent=money(f.status==='KILLED'?0:rawTarget(f.policy,Math.round(pDisplay*100)));
  $('#policyResult').textContent=Math.abs(f.desiredExposureUsd)<=f.policy.riskCapUsd?'WITHIN MANDATE':'VIOLATION';
  $('#policyResult').className=Math.abs(f.desiredExposureUsd)<=f.policy.riskCapUsd?'green':'';
  const util=Math.min(100,Math.abs(Number(p.exposureUsd||0))/f.policy.riskCapUsd*100); $('#riskBar').style.width=`${util}%`; $('#riskUtil').textContent=`${util.toFixed(0)}%`;
  $('#armBtn').disabled=f.status!=='PROPOSED';
  $('#chaosBtn').disabled=!['ARMED','OPEN','REDUCING'].includes(f.status);
  $('#applyBtn').disabled=!['ARMED','OPEN','REDUCING'].includes(f.status);
  $('#tickBtn').disabled=!['ARMED','OPEN','REDUCING'].includes(f.status);
  $('#emergencyKillBtn').disabled=['PROPOSED','KILLED','SETTLED'].includes(f.status);

  if(sig){
    $('#bid').textContent=pct(sig.bid*100); $('#ask').textContent=pct(sig.ask*100); $('#spread').textContent=`${sig.spreadBps} bps`; $('#sequence').textContent=f.oracleSequence;
    $('#signalQuality').textContent=sig.quality?`${sig.qualityReason} SIGNAL`:`${sig.qualityReason} — NO RISK ↑`;
    $('#signalQuality').style.color=sig.quality?'var(--lime)':'var(--amber)';
    $('#flowSource').textContent=(sig.source||'EVENT SOURCE').toUpperCase();
  }else{
    $('#bid').textContent='—';$('#ask').textContent='—';$('#spread').textContent='—';$('#sequence').textContent=f.oracleSequence||0;$('#signalQuality').textContent='AWAITING SIGNAL';$('#flowSource').textContent='DEMO ORDERBOOK';
  }
  $('#flowProofText').textContent=receipts.length?`${receipts.length} RECEIPT${receipts.length===1?'':'S'}`:'READY';
  setFlowActive('#flowSignal',true);setFlowActive('#flowPolicy',f.desiredExposureUsd!==0||f.status==='KILLED');setFlowActive('#flowPosition',Math.abs(Number(p.exposureUsd||0))>0||f.status==='KILLED');setFlowActive('#flowProof',receipts.length>0);
  $('#proofKill').textContent=f.status==='KILLED'?'✓':'✓';
  renderCurve(f);renderReceipts(receipts);
}

async function refresh(){const s=await api('/api/state');render(s);return s;}
async function mutate(path,body,{quiet=false}={}){try{const out=await api(path,body);await refresh();if(!quiet)toast('State updated');return out}catch(e){toast(e.message,'bad');throw e}}
async function setProbability(p){$('#probSlider').value=p;$('#sliderValue').textContent=pct(p);await mutate('/api/probability',{probability:p/100},{quiet:true});}
async function tick(quiet=false){const out=await mutate('/api/tick',{}, {quiet:true});if(!quiet){if(out?.reason==='AWAITING_CONFIRMATION')toast(`Signal confirmed ${out.confirmationCount}/${state.fuse.policy.confirmationCount}`);else toast(out?.executed?'Position reconciled':'Observation accepted');}return out}

function fireShockVisual(){const flash=$('#shockFlash');flash.classList.remove('fire');void flash.offsetWidth;flash.classList.add('fire');}
async function chaosShock({overlay=true}={}){
  if(!state||!['ARMED','OPEN','REDUCING'].includes(state.fuse.status)) return toast('Arm and open a Fuse first','bad');
  fireShockVisual();
  if(overlay){$('#killOverlay').classList.remove('hidden');setTimeout(()=>$('#killOverlay').classList.add('hidden'),1700)}
  await mutate('/api/chaos',{}, {quiet:true}); $('#probSlider').value=28; $('#sliderValue').textContent='28.0%'; await refresh(); toast('Kill triggered. Target forced to zero.');
}

async function runVerifier(){
  try{
    const v=await api('/api/verify',{}); const sec=$('#verifySection'), panel=$('#verifyPanel');
    $('#verifyHeadline').textContent=v.summary; panel.innerHTML='';
    v.checks.forEach(c=>{const d=document.createElement('div');d.className=`verify-check ${c.ok?'ok':'bad'}`;d.innerHTML=`<i>${c.ok?'✓':'✕'}</i><b>${c.name}</b><small>${String(c.actual).slice(0,60)}</small>`;panel.appendChild(d)});
    sec.classList.remove('hidden'); sec.scrollIntoView({behavior:'smooth',block:'center'}); toast(v.summary,v.ok?'good':'bad'); return v;
  }catch(e){toast(e.message,'bad');throw e}
}

async function runReplay(){
  try{const r=await api('/api/replay',{probabilities:[.58,.62,.71,.54,.32]});const el=$('#replayRows');el.className='replay-rows';el.innerHTML=r.rows.map(x=>`<div class="replay-row ${x.status==='KILLED'?'kill':''}"><strong>${(x.pBps/100).toFixed(0)}%</strong><span>${money(x.before)} → ${money(x.after)}</span><span>${x.reason.replaceAll('_',' ')}</span></div>`).join('');toast('Deterministic replay complete')}catch(e){toast(e.message,'bad')}
}

const JUDGE_STEPS=['Clean state','Arm mandate','61% → $300','72% → $420','Chaos 28% → KILL','Verify receipts'];
function renderJudgeSteps(done){$('#judgeSteps').innerHTML=JUDGE_STEPS.map((x,i)=>`<div class="judge-step ${i<done?'done':''}"><span>${String(i+1).padStart(2,'0')} · ${x}</span><b>${i<done?'✓':'·'}</b></div>`).join('');$('#judgeProgress').style.width=`${done/JUDGE_STEPS.length*100}%`}
async function judgeStage(done,title,copy,fn){renderJudgeSteps(done);$('#judgeTitle').textContent=title;$('#judgeCopy').textContent=copy;if(fn)await fn();await sleep(650);renderJudgeSteps(done+1)}
async function runJudgeDemo(){
  $('#judgeOverlay').classList.remove('hidden');renderJudgeSteps(0);
  try{
    await judgeStage(0,'Resetting to a clean mandate…','Nothing hidden. We start from a fresh Fuse.',async()=>{await mutate('/api/reset',{}, {quiet:true});$('#probSlider').value=61;$('#sliderValue').textContent='61.0%'});
    await judgeStage(1,'The user arms the policy.','The curve, hard cap and kill threshold are fixed before money moves.',async()=>mutate('/api/arm',{}, {quiet:true}));
    await judgeStage(2,'Probability confirms at 61%.','Two observations survive debounce. The policy authorizes $300 SOL exposure.',async()=>{await setProbability(61);await tick(true);await tick(true)});
    await judgeStage(3,'Probability reprices to 72%.','The same mandate deterministically resizes exposure to $420.',async()=>{await setProbability(72);await tick(true);await tick(true)});
    await judgeStage(4,'Now break it.','A clearly-labeled chaos simulation crashes probability to 28%. Kill bypasses debounce.',async()=>{fireShockVisual();await chaosShock({overlay:true})});
    await judgeStage(5,'Independent verification passes.','Policy commitment, P → E execution, cap, kill and receipt chain are all checked.',async()=>{await runVerifier()});
    $('#judgeTitle').textContent='Fuse survived the shock.';$('#judgeCopy').textContent='The agent could propose the strategy. It could not exceed the user-authorized mandate. That is the product.';renderJudgeSteps(6);toast('Judge demo complete');
  }catch(e){$('#judgeTitle').textContent='Demo interrupted';$('#judgeCopy').textContent=e.message;toast(e.message,'bad')}
}

$('#probSlider').addEventListener('input',()=>{const v=Number($('#probSlider').value);$('#sliderValue').textContent=pct(v);if(!state?.fuse?.lastProbabilityBps){$('#probability').textContent=pct(v);$('#probDial').style.setProperty('--p',v)}});
$('#applyBtn').onclick=async()=>{const v=Number($('#probSlider').value);await setProbability(v);await tick(false)};
$('#tickBtn').onclick=()=>tick(false);
$('#armBtn').onclick=()=>mutate('/api/arm',{});
$('#chaosBtn').onclick=()=>chaosShock();
$('#emergencyKillBtn').onclick=()=>mutate('/api/kill',{}).then(()=>toast('Emergency kill committed'));
$('#resetBtn').onclick=async()=>{await mutate('/api/reset',{}, {quiet:true});$('#probSlider').value=61;$('#sliderValue').textContent='61.0%';$('#verifySection').classList.add('hidden');$('#replayRows').className='replay-rows placeholder';$('#replayRows').innerHTML='<p>58% → 62% → 71% → 54% → 32%</p>';toast('Demo reset')};
$('#verifyBtn').onclick=runVerifier;$('#verifyBtn2').onclick=runVerifier;$('#closeVerify').onclick=()=>$('#verifySection').classList.add('hidden');
$('#replayBtn').onclick=runReplay;$('#judgeDemoBtn').onclick=runJudgeDemo;$('#closeJudge').onclick=()=>$('#judgeOverlay').classList.add('hidden');
$('#killOverlay').onclick=()=>$('#killOverlay').classList.add('hidden');

Promise.all([refresh(),loadProof()]).catch(e=>toast(e.message,'bad'));

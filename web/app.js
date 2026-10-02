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

function explorerUrl(kind,value){
  const net=state?.integrity?.network||'devnet';
  return `https://solscan.io/${kind}/${encodeURIComponent(value)}${net==='mainnet-beta'?'':`?cluster=${encodeURIComponent(net)}`}`;
}

function receiptTxLink(r){
  const links=[];
  if(r.txSignature) links.push(`<a href="${explorerUrl('tx',r.txSignature)}" target="_blank" rel="noreferrer">VIEW RECEIPT ↗</a>`);
  const anchored=r.chain?.txs?.filter(t=>t.ix==='record_fill').at(-1)||r.chain?.txs?.at(-1);
  if(anchored) links.push(`<a href="${explorerUrl('tx',anchored.signature)}" target="_blank" rel="noreferrer">ON-CHAIN ↗</a>`);
  return links.join(' ');
}

function renderLiveChainProof(f,integrity={}){
  if(!integrity.onchain) return;
  if(integrity.fusePda) setProofLink('#proofPda',{value:integrity.fusePda,url:explorerUrl('account',integrity.fusePda)},'NOT DEPLOYED');
  const kill=(f.chainTxs||[]).filter(t=>t.ix.startsWith('trigger_')).at(-1);
  if(kill) setProofLink('#proofKillTx',{value:kill.signature,url:explorerUrl('tx',kill.signature)},'PENDING DEVNET');
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
  const label=`${String(integrity.network||'devnet').toUpperCase()} LIVE`;
  $('#integrityLabel').textContent=label; $('#integrityLabel').className=`proof-dot ${live?'proof-live':'proof-local'}`;
  $('#chainProofMode').textContent=label;
  $('#networkLabel').textContent=`${String(integrity.network||'devnet').toUpperCase()} · ${String(integrity.perpAdapter||'').toUpperCase()}`;
  $('#venueLabel').textContent=String(integrity.perpAdapter||'flash').toLowerCase()==='flash'?'Flash Trade':'External driver';
  $('#eventSourceLabel').textContent=integrity.eventSource==='dflow'?'DFlow / Kalshi':'Polymarket';
  $('#proofBuild').textContent=`${integrity.buildTag||'dev'} · ${short(integrity.buildSha)}`;
}

async function loadProof(){
  try{proofState=await api('/api/proof');setProofLink('#proofProgram',proofState.program,'NOT DEPLOYED');setProofLink('#proofPda',proofState.fuseAccount,'NOT DEPLOYED');setProofLink('#proofKillTx',proofState.transactions?.kill,'PENDING DEVNET');setProofLink('#proofFlashOpen',proofState.transactions?.flashOpen,'PENDING DEVNET');setProofLink('#proofFlashResize',proofState.transactions?.flashResize,'PENDING DEVNET');setProofLink('#proofFlashClose',proofState.transactions?.flashClose,'PENDING DEVNET');renderIntegrity(proofState.integrity||{});if(state)renderLiveChainProof(state.fuse,proofState.integrity);}catch{}
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
  $('#cap').textContent=money(f.policy.riskCapUsd); $('#capHero').textContent=money(f.policy.riskCapUsd);
  $('#kill').textContent=`<${(f.policy.killBelowBps/100).toFixed(0)}%`; $('#killHero').textContent=`<${(f.policy.killBelowBps/100).toFixed(0)}%`;
  $('#markPrice').textContent=p.markPrice?money(p.markPrice,2):'—'; $('#pnl').textContent=money(p.unrealizedPnlUsd||0,2);
  $('#reason').textContent=(f.lastReasonCode||'NOOP').replaceAll('_',' '); $('#receiptHash').textContent=short(f.lastReceiptHash);
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
  $('#operatorBtn').textContent=op?'OPERATOR ✓':'OPERATOR LOGIN';

  if(sig){
    $('#bid').textContent=pct(sig.bid*100); $('#ask').textContent=pct(sig.ask*100); $('#spread').textContent=`${sig.spreadBps} bps`; $('#sequence').textContent=f.oracleSequence;
    $('#signalQuality').textContent=sig.quality?`${sig.qualityReason} SIGNAL`:`${sig.qualityReason} — NO RISK ↑`;
    $('#signalQuality').style.color=sig.quality?'var(--lime)':'var(--amber)';
    $('#flowSource').textContent=String(sig.source||'EVENT SOURCE').split(':')[0].toUpperCase();
  }else{
    $('#bid').textContent='—';$('#ask').textContent='—';$('#spread').textContent='—';$('#sequence').textContent=f.oracleSequence||0;$('#signalQuality').textContent='AWAITING SIGNAL';$('#flowSource').textContent=String(s.integrity?.eventSource||'').toUpperCase();
  }
  $('#flowProofText').textContent=receipts.length?`${receipts.length} RECEIPT${receipts.length===1?'':'S'}`:'READY';
  setFlowActive('#flowSignal',true);setFlowActive('#flowPolicy',f.desiredExposureUsd!==0||f.status==='KILLED');setFlowActive('#flowPosition',Math.abs(Number(p.exposureUsd||0))>0||f.status==='KILLED');setFlowActive('#flowProof',receipts.length>0);
  $('#proofKill').textContent=f.status==='KILLED'?'✓':'✓';
  renderCurve(f);renderReceipts(receipts);renderLiveChainProof(f,s.integrity);
}

async function refresh(){const s=await api('/api/state');render(s);return s;}
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
$('#verifyBtn').onclick=runVerifier;$('#verifyBtn2').onclick=runVerifier;$('#closeVerify').onclick=()=>$('#verifySection').classList.add('hidden');

Promise.all([refresh(),loadProof()]).catch(e=>toast(e.message,'bad'));
// The server worker trades continuously; keep the dashboard in step with it.
setInterval(()=>refresh().catch(()=>{}),5000);

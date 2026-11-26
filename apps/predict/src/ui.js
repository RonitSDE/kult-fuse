import {PROGRAM_ID,DEVNET_MUSDC,evaluatePrediction,recheckBeforeBroadcast} from '../../../src/predict/policy.mjs';
import {LP_EXIT_JOURNAL_KIND} from '../../../src/predict/lp-exit.mjs';
import {vaultStatus,vaultOdds} from '../../../src/predict/vault.mjs';
import {fetchMarketList,refreshMarket,exactQuote,minForBps,ensureWallet,hasLegacyWallet,getWallet,availableWallets,connectWallet,disconnectWallet,restoreWallet,onWalletChange,getMusdcBalance,getOutcomeBalances,connection,buyPrediction,provideLiquidity,claimWinnings,faucet,exactSellQuote,sellPrediction,getOutcomeBalancesRaw,ensureSolForFees,readLpExitState,runLpExit,waitForConfirmation,explorer,fetchVaults,commitToVault,refundVaultCommit,claimVaultLp} from './predict-client.js';
import { loadTradeSession, saveTradeSession, startTradeSession, withTradeLock } from './trade-session.js';
const $=id=>document.getElementById(id);
const format=(n,digits=2)=>n != null && Number.isFinite(Number(n))?Number(n).toLocaleString('en-US',{maximumFractionDigits:digits}):'—';
const short=s=>s?`${s.slice(0,5)}…${s.slice(-5)}`:'—';
const escapeHtml=s=>String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const journalKey='kult-fuse-predict-journal-v1';
let markets=[],selected=null,side='yes',quote=null, busy=false,lastRefreshAt=0,quoteRevision=0,checkingReceipts=false;
let vaults = [], selectedVault = null, vaultSide = 'yes', lifecycleProof;
let linkedMarket, lifecycleRequest = 0;
function journal(){try{const arr=JSON.parse(localStorage.getItem(journalKey));return Array.isArray(arr)?arr:[]}catch{return []}}
function writeJournal(entry){const items=journal();items.unshift(entry);localStorage.setItem(journalKey,JSON.stringify(items.slice(0,100)));renderJournal();}
function setStatus(text,tone=''){const el=$('statusText');el.textContent=text;el.className='trade-status '+tone;}
function setBusy(flag){busy=flag;for(const id of ['vaultLpPayoutBtn','sellBtn','lpWithdrawBtn','lpClaimBtn','tradeBtn','walletBtn','fundBtn','lpBtn','claimBtn','refreshMarkets','refreshVaults','vaultCommitBtn','vaultClaimBtn','vaultRefundBtn','restoreWalletBtn','refreshQuoteBtn'])$(id).disabled=flag;renderProgress();renderVaultSelected();if(!flag){$('tradeBtn').disabled=!quote?.allowed;$('sellBtn').disabled=!sellQ?.allowed;void refreshBalance();}}
function currentWallet(){try{return getWallet()?.publicKey.toBase58()||null}catch{return null}}
function getLimits() {
  return { maxSingle: Number($('maxSingle').value), maxTotal: Number($('maxTotal').value),
    maxSlippageBps: Number($('slippage').value) };
}
function mandate() { return loadTradeSession(currentWallet()); }
function clearQuote() {
  quote = null;
  for (const id of ['quoteOutput', 'quoteFee', 'quoteMinimum', 'quotePayout']) $(id).textContent = '—';
  $('mandateDecision').textContent = 'Waiting for live quote';
  $('mandateDecision').className = '';
  $('tradeBtn').disabled = true;
  $('tradeBtn').textContent = 'Review a live quote';
}
function renderProgress() {
  const session = mandate();
  const active = session?.expiresAtMs > Date.now();
  if (active) {
    $('maxSingle').value = session.maxSingle;
    $('maxTotal').value = session.maxTotal;
    $('slippage').value = session.maxSlippageBps;
  }
  for (const id of ['maxSingle', 'maxTotal', 'slippage']) $(id).disabled = busy || active;
  $('armBtn').disabled = busy || active || !selected || !currentWallet();
  $('killBtn').disabled = !active;
  $('killBtn').textContent = session?.killed && active ? 'Resume session' : 'Pause session';
  $('sessionSpent').textContent = active
    ? `${format(session.spent)} / ${format(session.maxTotal)} mUSDC reserved` : 'No active session';
  $('progressFill').style.width = active ? Math.min(100, 100 * session.spent / session.maxTotal) + '%' : '0%';
  $('sessionExpiry').textContent = active
    ? `${session.killed ? 'Paused · ' : ''}Locked until ${new Date(session.expiresAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${session.marketPda === selected?.marketPda ? 'Selected market' : 'Different market'}`
    : 'Approve a one-hour budget for this market.';
}
function renderSide(){for(const [id,val] of [['sideYes','yes'],['sideNo','no']]){$(id).classList.toggle('selected',side===val);$(id).setAttribute('aria-pressed',String(side===val));}}
// ---------- market discovery: search, category chips, sort (all from live devnet accounts) ----------
let marketQuery='',marketCat='all',marketSort='ending';
const CATS=[['all','All'],['crypto','Crypto'],['stocks','Stocks'],['solana','Solana network'],['macro','Macro'],['other','Other']];
function categoryOf(name){
 const n=String(name||'');
 if(/mainnet|\bslot\b|\btps\b/i.test(n))return 'solana';
 if(/\b[A-Z]{2,5}x\b/.test(n))return 'stocks';
 if(/\b(BTC|ETH|SOL|BNB|XRP|DOGE)\b|\$[A-Za-z]/.test(n))return 'crypto';
 if(/\b[A-Z]{3}\/[A-Z]{3}\b|\brate\b|\bCPI\b|\bFed\b/i.test(n))return 'macro';
 return 'other';
}
function relTime(endTs){
 const s=Math.round(endTs-Date.now()/1000);if(s<=0)return 'Closed';
 const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
 return d?`${d}d ${h}h`:h?`${h}h ${m}m`:`${Math.max(1,m)}m`;
}
function visibleMarkets(){
 const q=marketQuery.trim().toLowerCase();
 const list=markets.filter(m=>(marketCat==='all'||categoryOf(m.name)===marketCat)&&(!q||m.name.toLowerCase().includes(q)||String(m.marketId).includes(q)));
 const p=m=>Number.isFinite(m.price)?m.price:.5;
 const by={ending:(a,b)=>a.endTs-b.endTs,uncertain:(a,b)=>Math.abs(p(a)-.5)-Math.abs(p(b)-.5),yes:(a,b)=>p(b)-p(a),no:(a,b)=>p(a)-p(b)}[marketSort];
 return list.sort(by);
}
function renderChips(){
 const counts={all:markets.length};for(const m of markets){const c=categoryOf(m.name);counts[c]=(counts[c]||0)+1;}
 $('marketChips').innerHTML=CATS.filter(([id])=>id==='all'||counts[id]).map(([id,label])=>`<button type="button" class="chip" data-cat="${id}" aria-pressed="${marketCat===id}">${label}<span>${counts[id]||0}</span></button>`).join('');
}
function renderMarkets(){
 $('marketCount').textContent=`${markets.length} active markets · onchain`;
 renderChips();renderHero();
 if(!markets.length){$('marketsList').innerHTML='<div class="market-loading">No active PREDICT markets were found on devnet right now. Markets appear here as soon as a builder creates one.</div>';return;}
 const view=visibleMarkets();
 if(!view.length){$('marketsList').innerHTML='<div class="market-loading">No live markets match this filter.</div>';return;}
 $('marketsList').innerHTML=view.map(m=>{const y=Number.isFinite(m.price)?Math.round(m.price*100):null;const cat=CATS.find(c=>c[0]===categoryOf(m.name))[1];const soon=m.endTs-Date.now()/1000<3600;
  return `<button type="button" aria-pressed="${selected?.marketPda===m.marketPda}" class="market-row ${selected?.marketPda===m.marketPda?'selected':''}" data-market="${escapeHtml(m.marketPda)}"><span class="row-main"><span class="row-tags"><span class="row-cat">${cat}</span><span class="row-ends ${soon?'soon':''}">${soon?'Closing · ':''}${relTime(m.endTs)}</span></span><b>${escapeHtml(m.name)}</b><span class="row-meta">#${Number(m.marketId)||'?'} · Ends ${new Date(m.endTs*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span><span class="row-bar"><i data-w="${y??50}"></i></span></span><span class="row-odds"><span class="odd yes">Yes <b>${y??'—'}¢</b></span><span class="odd no">No <b>${y==null?'—':100-y}¢</b></span></span></button>`;}).join('');
 // CSP (style-src 'self') blocks inline style attributes in markup; set bar widths via the DOM.
 for(const bar of $('marketsList').querySelectorAll('.row-bar i[data-w]'))bar.style.width=`${Number(bar.dataset.w)}%`;
 $('marketsList').querySelectorAll('[data-market]').forEach(btn=>btn.addEventListener('click',()=>{if(busy)return;selected=markets.find(x=>x.marketPda===btn.dataset.market);onMarketChange();$('marketsList').querySelector('[aria-pressed="true"]')?.focus();}));
}
// hero: the next live market to close, straight from devnet
let heroMarket=null;
function renderHero(){
 heroMarket=[...markets].filter(m=>Number.isFinite(m.price)).sort((a,b)=>a.endTs-b.endTs)[0]||null;
 $('chipMarkets').textContent=markets.length?format(markets.length,0):'0';
 if(!heroMarket){$('heroLiveTitle').textContent='No live market on devnet right now';$('heroTrade').disabled=true;$('heroLiveEnds').textContent='—';return;}
 const y=heroMarket.price*100;
 $('heroLiveTitle').textContent=heroMarket.name;
 $('heroLiveEnds').textContent=`Closes in ${relTime(heroMarket.endTs)}`;
 $('heroYes').textContent=`${y.toFixed(1)}%`;$('heroNo').textContent=`${(100-y).toFixed(1)}%`;
 $('heroBar').style.width=`${y}%`;
 $('heroLiveMeta').textContent=`Market #${heroMarket.marketId} · PREDICT pm-AMM`;
 $('heroTrade').disabled=false;
}
function renderLive(){
 const m=selected;
 if(!m){$('liveMarketName').textContent='Choose a market above';return;}
 const now=Date.now()/1000,y=Number.isFinite(m.price)?m.price*100:null;
 $('liveMarketName').textContent=m.name;
 $('liveMarketLink').href=`https://solscan.io/account/${encodeURIComponent(m.marketPda)}?cluster=devnet`;
 $('liveYes').textContent=y==null?'—':`${y.toFixed(1)}%`;$('liveNo').textContent=y==null?'—':`${(100-y).toFixed(1)}%`;
 $('liveSplitYes').style.flexGrow=String(Math.max(8,y??50));$('liveSplitNo').style.flexGrow=String(Math.max(8,100-(y??50)));
 const fmt=t=>new Date(t*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
 $('liveStart').textContent=Number.isFinite(m.startTs)?fmt(m.startTs):'—';$('liveEnd').textContent=fmt(m.endTs);$('liveLeft').textContent=relTime(m.endTs);
 $('liveOpen').textContent=Number.isFinite(m.openingPriceBps)?`${(m.openingPriceBps/100).toFixed(1)}%`:'—';
 const elapsed=Number.isFinite(m.startTs)&&m.endTs>m.startTs?Math.min(1,Math.max(0,(now-m.startTs)/(m.endTs-m.startTs))):null;
 $('liveElapsed').textContent=elapsed==null?'—':`${(elapsed*100).toFixed(1)}%`;$('liveTimeBar').style.width=`${(elapsed??0)*100}%`;
 $('liveStatus').textContent=m.resolved?'Resolved':m.endTs<=now?'Closed':'Open';
}
async function refreshSlot(){try{$('chipSlot').textContent=format(await connection.getSlot('confirmed'),0);}catch{}}
let walletBalance=null;
async function refreshBalance(){
 if(!currentWallet()){walletBalance=null;$('walletBalance').textContent='Balance —';return;}
 try{walletBalance=await getMusdcBalance();$('walletBalance').textContent=`Balance ${format(walletBalance)} mUSDC`;}catch{$('walletBalance').textContent='Balance unavailable';}
}
function onMarketChange(){renderMarkets();renderProgress();clearQuote();renderDecay();renderLive();void refreshPosition();
 if(selected){$('tradeQuestion').textContent=selected.name;$('tradeExpiry').textContent=`Market #${selected.marketId} · ends ${new Date(selected.endTs*1000).toLocaleString()}`;$('yesOdds').textContent=`${(selected.price*100).toFixed(1)}%`;$('noOdds').textContent=`${((1-selected.price)*100).toFixed(1)}%`;$('marketExplorer').href=`https://solscan.io/account/${encodeURIComponent(selected.marketPda)}?cluster=devnet`;$('marketExplorer').classList.remove('hidden');}
 else{$('tradeQuestion').textContent='Choose a market on the left';$('marketExplorer').classList.add('hidden');}
 void makeQuote();
}
function renderDecay(){
 const el=$('decayFactor'),note=$('decayNote');
 const from=selected?.startTs, end=selected?.endTs;
 if(!Number.isFinite(from)||!Number.isFinite(end)||end<=from){el.textContent='—';note.textContent='Onchain market timing unavailable';return;}
 const proportion=Math.min(1,Math.max(0,(end-Date.now()/1000)/(end-from)));
 el.textContent=(Math.sqrt(proportion)*100).toFixed(1)+'%';
 note.textContent='From this market\'s onchain start and end time. pm-AMM liquidity shrinks with √(time left) as expiry approaches.';
}
function agentSuggestion(){if(busy)return;if(!selected){setStatus('Select market first','error');return;}const p=selected.price;
 if(p>=0.45&&p<=0.55){$('agentInsight').textContent='Rule-based strategy: HOLD. Both outcomes are close to 50%, so this simple rule proposes no trade.';return;}
 side=p<0.45?'yes':'no';renderSide();
 $('agentInsight').textContent=`Rule-based contrarian proposal: ${side.toUpperCase()} is the less-expensive side at ${((side==='yes'?p:1-p)*100).toFixed(1)}%. This is not an AI forecast or investment advice. You must still approve the trade.`;makeQuote();}
async function makeQuote({ quiet = false } = {}) {
  const revision = ++quoteRevision;
  clearQuote();
  renderProgress();
  if (!selected) return;
  const marketPda = selected.marketPda;
  try {
    const fresh = await refreshMarket(marketPda);
    if (revision !== quoteRevision || selected?.marketPda !== marketPda) return;
    selected = fresh;
    renderLive();
    if (Number.isFinite(fresh.price)) {
      $('yesOdds').textContent = `${(fresh.price * 100).toFixed(1)}%`;
      $('noOdds').textContent = `${((1 - fresh.price) * 100).toFixed(1)}%`;
    }
    const amount = Number($('tradeAmount').value);
    if (!Number.isFinite(amount) || amount < 0.1 || amount > 100) throw new Error('Enter 0.1–100 mUSDC');
    quote = exactQuote(fresh, side === 'yes' ? 'usdcToYes' : 'usdcToNo', amount);
    quote.minRaw = minForBps(quote, getLimits().maxSlippageBps);
    quote.side = side;
    const session = mandate();
    const check = evaluatePrediction({ mandate: session, proposal: {
      wallet: currentWallet(), marketPda, side, amount, minOutRaw: quote.minRaw,
      quoteAtMs: quote.quoteAtMs, quoteMarketPda: marketPda
    }, market: fresh });
    $('quoteOutput').textContent = `${format(quote.quotedRaw / 1e6)} ${side.toUpperCase()}`;
    const payout = quote.quotedRaw / 1e6, profit = payout - amount;
    $('quotePayout').textContent = `${format(payout)} mUSDC (${profit >= 0 ? '+' : ''}${format(profit)})`;
    $('quotePayout').className = profit >= 0 ? 'allowed' : 'denied';
    $('quoteFee').textContent = `${format(quote.feeRaw / 1e6)} mUSDC est.`;
    $('quoteMinimum').textContent = `${(quote.minRaw / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${side.toUpperCase()}`;
    const unresolved = journal().some(row => row.wallet === currentWallet() && pendingSwap(row));
    quote.allowed = check.status === 'ALLOW_AS_APP_CHECK' && !unresolved;
    $('mandateDecision').textContent = unresolved ? 'Previous swap awaiting finality'
      : quote.allowed ? 'Within approved limits' : !session ? 'Approve session limits to trade' : check.reason;
    $('mandateDecision').className = quote.allowed ? 'allowed' : 'denied';
    $('tradeBtn').disabled = busy || !quote.allowed;
    $('tradeBtn').textContent = quote.allowed ? `Approve ${amount} mUSDC · Buy ${side.toUpperCase()}` : 'Trade unavailable';
    if (!quiet && !busy) setStatus(quote.allowed ? 'Check the minimum received before you approve.'
      : !currentWallet() ? 'Start with a Devnet test wallet.' : $('mandateDecision').textContent);
  } catch (error) {
    if (revision !== quoteRevision) return;
    clearQuote();
    $('mandateDecision').textContent = error.message;
    if (!quiet) setStatus('Live quote unavailable. Refresh to try again.', 'error');
  }
}

function renderWallet() {
  const w = getWallet();
  const wallet = w?.publicKey.toBase58() || null;
  const ext = w?.kind === 'external';
  $('restoreWalletBtn').hidden = Boolean(wallet) || !hasLegacyWallet();
  renderJournal();
  $('walletLine').textContent = !wallet ? 'No wallet connected' : ext ? `${w.label} ${short(wallet)} · Connected` : `Test wallet ${short(wallet)} · Saved in this browser`;
  $('walletBtn').textContent = wallet ? `${ext ? w.label : 'Test'} · ${short(wallet)}` : 'Connect wallet';
  $('fundBtn').textContent = wallet ? 'Request test funds ↗' : 'Create & fund test wallet ↗';
  $('walletDisconnect').hidden = !ext;
  $('walletBurner').hidden = ext;
  $('walletOptions').innerHTML = availableWallets().map(o => {
    const on = ext && w.id === o.id;
    return `<button class="wallet-option" type="button" role="menuitem" data-wallet="${o.id}" data-on="${on}"><span class="wallet-ic">${escapeHtml(o.label[0])}</span><span><b>${escapeHtml(o.label)}</b><small>${on ? 'Connected' : o.installed ? 'Detected' : 'Not installed · opens download'}</small></span></button>`;
  }).join('');
}

function toggleWalletPanel(open = $('walletPanel').hidden) {
  $('walletPanel').hidden = !open;
  $('walletBtn').setAttribute('aria-expanded', String(open));
  if (open) renderWallet();
}

async function chooseWallet(id) {
  if (busy) return;
  toggleWalletPanel(false);
  try {
    setStatus(`Waiting for ${id[0].toUpperCase() + id.slice(1)} approval…`);
    const w = await connectWallet(id);
    setStatus(`${w.label} connected: ${short(w.publicKey.toBase58())}. Make sure it is set to Devnet.`, 'ok');
  } catch (error) { setStatus(error.message, 'error'); }
}

async function createAndFund({ restore = false } = {}) {
  if (busy) return;
  if (!currentWallet() && !confirm('Create a Devnet test wallet saved in this browser? It holds test funds only and comes back when you return. Clearing browser data removes it.')) return;
  setBusy(true);
  try {
    ensureWallet({ restore });
    renderWallet();
    if (restore) {
      setStatus('Test wallet ready.', 'ok');
      return;
    }
    setStatus('Requesting test SOL and mUSDC from PREDICT…');
    let result = null, faucetError = null;
    try { result = await faucet(); } catch (error) { faucetError = error; }
    const balance = await getMusdcBalance();
    // The PREDICT faucet may skip its SOL drip (reserve low or per-IP cap). Fees still need SOL.
    if (!result?.sol) setStatus('Checking SOL for network fees…');
    const sol = await ensureSolForFees();
    if (!sol.ok) { showSolHelp(sol, `Wallet has ${format(balance)} mUSDC.`); return; }
    if (faucetError && !(balance > 0)) throw faucetError;
    setStatus(`Wallet ready: ${format(balance)} mUSDC and ${sol.sol.toFixed(3)} SOL for fees.${result?.signature ? ' Funding receipt ' + short(result.signature) + '.' : ''}`, 'ok');
  } catch (error) {
    failStatus(error);
  } finally {
    setBusy(false);
    void makeQuote({ quiet: true });
  }
}

const pendingStates = new Set(['SUBMITTED', 'PENDING', 'CONFIRMED', 'SUBMITTED_AWAITING_CONFIRMATION',
  'ONCHAIN_CONFIRMED_PENDING_INDEPENDENT_CHECK', 'PENDING_INDEPENDENT_VERIFICATION']);
const pendingSwap = entry => !entry.kind && pendingStates.has(entry.status);

async function sendTrade() {
  if (busy || !selected || !quote?.allowed) return;
  const approved = { ...quote };
  const wallet = currentWallet();
  const marketPda = selected.marketPda;
  const amount = approved.raw / 1e6;
  let signature;
  setBusy(true);
  try {
    await withTradeLock(wallet, async () => {
      if (journal().some(row => row.wallet === wallet && pendingSwap(row))) {
        throw new Error('Check the existing swap receipt before starting a new trade');
      }
      if (Date.now() - approved.quoteAtMs > 15_000) throw new Error('Quote refreshed. Review it before approving.');
      const fresh = await refreshMarket(marketPda);
      const revised = exactQuote(fresh, approved.side === 'yes' ? 'usdcToYes' : 'usdcToNo', amount);
      if (revised.quotedRaw < approved.minRaw) {
        throw new Error('Price moved. Review the updated minimum before approving.');
      }
      if (await getMusdcBalance() < amount) throw new Error('Insufficient test mUSDC. Request test funds.');
      await requireSol();
      setStatus('Preparing your approved Devnet swap…');
      await buyPrediction(fresh, approved.side, approved.raw, approved.minRaw, {
        beforeSend() {
          if (selected?.marketPda !== marketPda || side !== approved.side ||
              Number($('tradeAmount').value) !== amount) throw new Error('Trade details changed. Review again.');
          const result = evaluatePrediction({ mandate: mandate(), market: fresh, proposal: {
            wallet, marketPda, side: approved.side, amount, minOutRaw: approved.minRaw,
            quoteAtMs: approved.quoteAtMs, quoteMarketPda: approved.marketPda
          } });
          if (result.status !== 'ALLOW_AS_APP_CHECK') throw new Error(result.reason);
        },
        beforeBroadcast(signer) {
          const check = recheckBeforeBroadcast({ action: 'buy', mandate: mandate(), wallet, activeWallet: currentWallet(),
            signer, marketPda, amount, market: fresh });
          if (!check.ok) throw new Error(check.reason);
        },
        onSigned(signed, lastValidBlockHeight) {
          const current = mandate();
          saveTradeSession({ ...current, spent: Number((current.spent + amount).toFixed(6)) });
          writeJournal({ signature: signed, wallet, marketPda, marketName: fresh.name, side: approved.side,
            amount, lastValidBlockHeight, at: Date.now(), status: 'SUBMITTED' });
          signature = signed;
          $('lastReceipt').innerHTML = `<a href="${explorer(signed)}" target="_blank" rel="noopener noreferrer">View transaction on Solscan ↗</a>`;
        }
      });
    });
    setStatus('Swap broadcast. Check its receipt below.', 'ok');
  } catch (error) {
    if (signature) setStatus('Broadcast status is uncertain. Fuse will check the saved signature.', 'error'); else failStatus(error);
  } finally {
    setBusy(false);
    if (signature) void reconcileReceipts();
    void makeQuote({ quiet: true });
  }
}

function updateJournal(signature, changes) {
  localStorage.setItem(journalKey, JSON.stringify(journal().map(row => row.signature === signature ? { ...row, ...changes } : row)));
  renderJournal();
}

async function reconcileReceipts() {
  if (checkingReceipts) return;
  const row = journal().find(entry => pendingSwap(entry));
  if (!row) return;
  checkingReceipts = true;
  try {
    const { signature, wallet, marketPda } = row;
    const response = await fetch('/api/predict/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature, wallet, marketPda }), signal: AbortSignal.timeout(21000)
    });
    const result = await response.json();
    let status;
    if (result.state === 'finalized' && result.verified) status = 'FINALIZED';
    else if (result.state === 'confirmed') status = 'CONFIRMED';
    else if (result.state === 'failed') status = 'FAILED';
    else if (result.state === 'rejected') status = 'VERIFICATION_REJECTED';
    else if (result.state === 'pending' && Date.now() - row.at > 120000) {
      const [height, signatureStatus] = await Promise.all([
        connection.getBlockHeight('finalized'), connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
      ]);
      if (!signatureStatus.value[0] && Number.isFinite(row.lastValidBlockHeight) && height > row.lastValidBlockHeight) status = 'EXPIRED';
      if (!Number.isFinite(row.lastValidBlockHeight) && Date.now() - row.at > 600000 && !signatureStatus.value[0]) status = 'UNAVAILABLE';
    }
    if (status && status !== row.status) {
      updateJournal(signature, { status, reason: result.reason });
      if (!busy && wallet === currentWallet()) {
        const message = { FINALIZED: 'Finalized on Solana and recorded on the scoreboard.',
          CONFIRMED: 'Confirmed on Solana. Waiting for finality.',
          EXPIRED: 'Transaction expired before finality.',
          FAILED: 'Solana reported a failed transaction.', VERIFICATION_REJECTED: result.reason,
          UNAVAILABLE: 'This legacy receipt was not found on Devnet.' };
        setStatus(message[status], ['FINALIZED', 'CONFIRMED'].includes(status) ? 'ok' : 'error');
        if (status !== 'CONFIRMED') void makeQuote({ quiet: true });
      }
      if (status === 'FINALIZED') void loadStats();
    }
  } catch {
    // Keep the saved signature pending during a temporary RPC or API outage.
  } finally {
    checkingReceipts = false;
  }
}

const receiptLabels = { SUBMITTED: 'Submitted', CONFIRMED: 'Confirmed · awaiting finality', FINALIZED: 'Finalized · verified',
  FAILED: 'Failed onchain', EXPIRED: 'Expired', UNAVAILABLE: 'Unavailable', VERIFICATION_REJECTED: 'Unverified',
  INDEPENDENTLY_VERIFIED: 'Legacy · confirmed', ONCHAIN_CONFIRMED_NOT_SWAP: 'Confirmed · vault activity',
  ONCHAIN_CONFIRMED_NOT_COUNTED_AS_TRADE: 'Confirmed · settlement or LP' };
function renderJournal() {
  const wallet = currentWallet();
  const entries = journal().filter(x => !wallet || x.wallet === wallet || !x.wallet);
  $('retryReceiptBtn').hidden = !entries.some(pendingSwap);
  $('journal').innerHTML = entries.length ? entries.slice(0, 8).map(e => `<div class="proof-entry"><span class="proof-ic" aria-hidden="true">↗</span><div class="proof-content"><strong>${escapeHtml(e.kind?.replaceAll('_', ' ') || (e.action === 'sell' ? 'SELL ' : '') + (e.side?.toUpperCase() || 'Trade'))}${e.amount > 0 ? ' · ' + format(e.amount) + (e.action === 'sell' ? ' tokens' : ' mUSDC') : ''}</strong><span>${escapeHtml(receiptLabels[e.status] || 'Awaiting verification')} · <a href="${explorer(e.signature)}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(e.signature))} ↗</a></span></div><span class="proof-time">${new Date(e.at).toLocaleDateString()}</span></div>`).join('') : '<p class="empty">Your Devnet transactions will appear here.</p>';
}
async function loadStats() {
  try {
    const response = await fetch('/api/predict/stats', { cache: 'no-store', signal: AbortSignal.timeout(9000) });
    if (!response.ok) throw new Error('Stats unavailable');
    const data = await response.json();
    $('metricWallets').textContent = format(data.uniqueTradingWallets);
    $('metricTrades').textContent = format(data.finalizedSwaps);
    $('metricVolume').textContent = format(data.mUsdcVolume,6);
    $('metricRepeat').textContent = format(data.repeatTraders);
    $('metricDaoFees').textContent = format(data.observedDaoFeesMUsdc,6);
    $('publicFeed').innerHTML = data.receipts.length ? data.receipts.slice(0, 8).map(e => `<div class="proof-entry"><span class="proof-ic" aria-hidden="true">✓</span><div class="proof-content"><strong>${e.action === 'sell' ? 'SELL ' : ''}${escapeHtml(e.side.toUpperCase())} · ${format(e.action === 'sell' ? e.received : e.spent)} mUSDC · ${escapeHtml(short(e.wallet))}</strong><span>FINALIZED · <a href="${explorer(e.signature)}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(e.signature))} ↗</a></span></div><span class="proof-time">${new Date(e.time * 1000).toLocaleDateString()}</span></div>`).join('') : '<p class="empty">No finalized Fuse swaps yet.</p>';
    if (Number.isFinite(data.sells)) $('metricTrades').title = `${data.buys ?? 0} buys · ${data.sells} sells`;
  } catch {
    for (const id of ['metricWallets', 'metricTrades', 'metricVolume', 'metricRepeat', 'metricDaoFees']) $(id).textContent = '—';
    $('publicFeed').innerHTML = '<p class="empty">Scoreboard temporarily unavailable.</p>';
  }
}
async function loadMarkets(){if(busy)return;setStatus('Reading PREDICT pm-AMM markets from Solana devnet…');$('marketCount').textContent='Fetching onchain';try{markets=await fetchMarketList();lastRefreshAt=Date.now();const deepMarket=new URLSearchParams(location.search).get('market');selected=markets.find(x=>x.marketPda===(selected?.marketPda || deepMarket))||markets[0]||null;renderMarkets();onMarketChange();}catch(e){markets=[];selected=null;$('marketsList').innerHTML=`<p class="empty">Onchain market discovery unavailable: ${escapeHtml(e.message)}. No markets are fabricated.</p>`;$('marketCount').textContent='RPC unavailable';setStatus('Market discovery failed: '+e.message,'error');}}
async function doLp(){if(busy)return;try{if(!selected||!currentWallet())throw Error('Select market and create test wallet first');setBusy(true);const m=await refreshMarket(selected.marketPda);if(m.resolved||m.endTs<Date.now()/1000)throw Error('Market has closed');const amount=Number($('lpAmount').value);if(!Number.isFinite(amount)||amount<1||amount>100)throw Error('LP deposit must be 1–100 mUSDC');if(!confirm(`Provide ${amount} mock-USDC of LP liquidity to this PREDICT market? Liquidity providers face economic risk. This is NOT a trade.`))return;setBusy(true);await requireSol();setStatus('Submitting real pm-AMM liquidity deposit…');const sig=await provideLiquidity(m,amount);await waitForConfirmation(sig);writeJournal({signature:sig,kind:'LP_DEPOSIT',amount,side:'LP',marketPda:m.marketPda,at:Date.now(),status:'ONCHAIN_CONFIRMED_NOT_COUNTED_AS_TRADE'});setStatus('LP deposit confirmed on devnet: '+short(sig),'ok')}catch(e){failStatus(e)}finally{setBusy(false)}}
async function doClaim(){if(busy)return;try{const addr=$('claimMarketPda').value.trim();if(!addr||!currentWallet())throw Error('Enter resolved market PDA and create wallet');setBusy(true);const m=await refreshMarket(addr);if(!m.resolved)throw Error('This market is not resolved yet');if(!confirm('Claim winning PREDICT tokens for this market?'))return;setBusy(true);await requireSol();const sig=await claimWinnings(m);await waitForConfirmation(sig);writeJournal({signature:sig,kind:'CLAIM',amount:0,side:'CLAIM',marketPda:addr,at:Date.now(),status:'ONCHAIN_CONFIRMED_NOT_COUNTED_AS_TRADE'});setStatus('Claim confirmed: '+short(sig),'ok')}catch(e){failStatus(e)}finally{setBusy(false)}}

// Market formation uses PREDICT's REAL Commitment Vault program, not synthetic rewards.
// ---------- v2.1.3: SOL for fees, sell before expiry, LP exit ----------
function showSolHelp(sol, prefix = '') {
  const el = $('statusText');
  el.className = 'trade-status error';
  el.textContent = `${prefix} This wallet has ${(sol.sol ?? 0).toFixed(4)} SOL and needs about 0.012 SOL for network fees. The devnet airdrop is rate-limited right now. Paste ${sol.address || 'your address'} into `.trim();
  const a = document.createElement('a');
  a.href = 'https://faucet.solana.com'; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'faucet.solana.com ↗';
  el.append(a, document.createTextNode(', then try again.'));
}
async function requireSol() {
  const sol = await ensureSolForFees();
  if (!sol.ok) { showSolHelp(sol); const e = new Error('SOL_NEEDED'); e.shown = true; throw e; }
}
function failStatus(error) { if (!error?.shown) setStatus(error.message, 'error'); }

let held = { yes: 0, no: 0 }, sellQ = null, sellRevision = 0;
async function refreshPosition() {
  const market = selected;
  if (!market || !currentWallet()) {
    held = { yes: 0, no: 0 }; $('heldYes').textContent = '—'; $('heldNo').textContent = '—';
    $('lpPositionText').textContent = market ? 'Connect a wallet to see your liquidity.' : 'Select a market to see your liquidity.';
    $('lpWithdrawBtn').hidden = $('lpClaimBtn').hidden = true; makeSellQuote(); return;
  }
  try {
    const { state, deposited } = await readLpExitState(market.marketPda);
    if (selected?.marketPda !== market.marketPda) return;
    held = { yes: state.yes, no: state.no };
    $('heldYes').textContent = format(state.yes / 1e6); $('heldNo').textContent = format(state.no / 1e6);
    const shares = state.lpShares > 0n;
    const unfinished = !shares && !state.resolved && Math.min(state.yes, state.no) > 0 && journal().some(r =>
      r.kind === 'LP_WITHDRAW' && r.marketPda === market.marketPda && r.wallet === currentWallet());
    $('lpPositionText').textContent = shares ? `Your liquidity here: ${format(deposited)} mUSDC deposited.`
      : unfinished ? 'Liquidity withdrawn. Matched YES+NO pairs are still waiting to be redeemed.'
      : state.hasLp ? (state.resolved ? 'Your liquidity position is still open on this resolved market.' : 'Your liquidity here has been withdrawn.')
      : 'You have no liquidity on this market.';
    $('lpWithdrawBtn').hidden = state.resolved || !(shares || unfinished);
    $('lpWithdrawBtn').textContent = unfinished ? 'Finish withdrawal: redeem pairs ↗' : 'Withdraw all liquidity ↗';
    $('lpClaimBtn').hidden = !(state.resolved && state.hasLp);
  } catch { $('heldYes').textContent = $('heldNo').textContent = '—'; }
  makeSellQuote();
}
function makeSellQuote() {
  const revision = ++sellRevision;
  sellQ = null; $('sellBtn').disabled = true; $('sellQuoteOut').textContent = '—'; $('sellQuoteMin').textContent = '—';
  const sellSide = $('sellSide').value, amount = Number($('sellAmount').value);
  if (!selected) return;
  if (selected.resolved || selected.endTs <= Date.now() / 1000) { $('sellBtn').textContent = selected.resolved ? 'Resolved · claim instead' : 'Market closed'; return; }
  if (!(held[sellSide] > 0)) { $('sellBtn').textContent = `No ${sellSide.toUpperCase()} to sell`; return; }
  if (!Number.isFinite(amount) || amount <= 0) { $('sellBtn').textContent = 'Enter tokens to sell'; return; }
  try {
    const q = exactSellQuote(selected, sellSide, amount);
    if (q.raw > held[sellSide]) throw new Error(`You hold ${format(held[sellSide] / 1e6)} ${sellSide.toUpperCase()}`);
    q.minRaw = minForBps(q, getLimits().maxSlippageBps);
    const pending = journal().some(row => row.wallet === currentWallet() && pendingSwap(row));
    q.allowed = !pending;
    if (revision !== sellRevision) return;
    sellQ = q;
    $('sellQuoteOut').textContent = `${format(q.quotedRaw / 1e6)} mUSDC`;
    $('sellQuoteMin').textContent = `${(q.minRaw / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} mUSDC`;
    $('sellBtn').disabled = busy || !q.allowed;
    $('sellBtn').textContent = pending ? 'Previous swap awaiting finality' : `Sell ${format(amount)} ${sellSide.toUpperCase()}`;
  } catch (error) { $('sellBtn').textContent = error.message; }
}
async function sendSell() {
  if (busy || !selected || !sellQ?.allowed) return;
  const approved = { ...sellQ }, wallet = currentWallet(), marketPda = selected.marketPda, tokens = approved.raw / 1e6;
  let signature;
  setBusy(true);
  try {
    await withTradeLock(wallet, async () => {
      if (journal().some(row => row.wallet === wallet && pendingSwap(row))) throw new Error('Check the existing swap receipt before starting a new trade');
      if (Date.now() - approved.quoteAtMs > 15_000) throw new Error('Sell quote expired. Review it again.');
      const fresh = await refreshMarket(marketPda);
      const revised = exactSellQuote(fresh, approved.side, tokens);
      if (revised.quotedRaw < approved.minRaw) throw new Error('Price moved. Review the updated minimum before approving.');
      const bal = await getOutcomeBalancesRaw(fresh);
      if (bal[approved.side] < approved.raw) throw new Error(`You no longer hold ${format(tokens)} ${approved.side.toUpperCase()}`);
      await requireSol();
      setStatus('Preparing your approved Devnet sell…');
      await sellPrediction(fresh, approved.side, approved.raw, approved.minRaw, {
        beforeSend() {
          if (selected?.marketPda !== marketPda || $('sellSide').value !== approved.side || Number($('sellAmount').value) !== tokens) throw new Error('Sell details changed. Review again.');
          if (fresh.resolved || fresh.endTs <= Date.now() / 1000) throw new Error('Market has closed');
        },
        beforeBroadcast(signer) {
          const check = recheckBeforeBroadcast({ action: 'sell', mandate: mandate(), wallet, activeWallet: currentWallet(),
            signer, marketPda, amount: tokens, market: fresh });
          if (!check.ok) throw new Error(check.reason);
        },
        onSigned(signed, lastValidBlockHeight) {
          writeJournal({ signature: signed, wallet, marketPda, marketName: fresh.name, side: approved.side, action: 'sell',
            amount: tokens, minUsdc: approved.minRaw / 1e6, lastValidBlockHeight, at: Date.now(), status: 'SUBMITTED' });
          signature = signed;
          $('lastReceipt').innerHTML = `<a href="${explorer(signed)}" target="_blank" rel="noopener noreferrer">View transaction on Solscan ↗</a>`;
        }
      });
    });
    setStatus('Sell broadcast. Check its receipt below.', 'ok');
    $('sellAmount').value = '';
  } catch (error) {
    if (signature) setStatus('Broadcast status is uncertain. Fuse will check the saved signature.', 'error'); else failStatus(error);
  } finally {
    setBusy(false);
    if (signature) void reconcileReceipts();
    void refreshPosition();
  }
}
const lpStepText = { claimCommitter: 'LP allocation claimed', withdrawLiquidity: 'liquidity withdrawn',
  redeemPair: 'YES+NO pairs redeemed', claimLpResiduals: 'pool share claimed', claimWinnings: 'winnings paid in mUSDC' };
/**
 * Shared LP exit for the market panel and the vault view. Each confirmed transaction is written to
 * the journal the moment it lands, so a failure later in the run loses nothing and a second click
 * resumes from chain state.
 */
async function doLpExit({ marketPda, vaultPda = null, report = setStatus }) {
  if (busy) return;
  const wallet = currentWallet();
  try {
    if (!wallet) throw new Error('Create your devnet test wallet first');
    const { market, state } = await readLpExitState(marketPda, vaultPda, wallet);
    const resolved = state.resolved;
    if (!confirm(resolved
      ? 'Claim your LP payout? Fuse claims your vault allocation if needed, mints your pool share, then redeems the winning side to mUSDC. Each step asks for a signature.'
      : 'Withdraw all of your liquidity from this market? You get YES and NO tokens back; matched pairs are redeemed to mUSDC straight away. A one-sided remainder stays in your wallet as a position you can sell or hold.')) return;
    setBusy(true); await requireSol();
    report(resolved ? 'Claiming your LP payout…' : 'Withdrawing liquidity from the pm-AMM…');
    const r = await runLpExit(marketPda, { vaultPda, owner: wallet, onStep(done) {
      writeJournal({ signature: done.signature, wallet, kind: LP_EXIT_JOURNAL_KIND[done.step], amount: done.amountRaw / 1e6,
        side: 'LP', marketPda, marketName: market.name, at: Date.now(), status: 'ONCHAIN_CONFIRMED_NOT_COUNTED_AS_TRADE' });
      report(`Saved: ${lpStepText[done.step]} (${short(done.signature)}). Continuing…`);
    } });
    if (!r.completed.length) { report(resolved ? 'Nothing left to claim for this wallet.' : 'Nothing left to withdraw.'); return; }
    const after = r.state;
    const left = after && !after.resolved ? [after.yes > 0 && `${format(after.yes / 1e6)} YES`, after.no > 0 && `${format(after.no / 1e6)} NO`].filter(Boolean).join(' and ') : '';
    const redeemed = r.completed.filter(x => x.step === 'redeemPair').reduce((n, x) => n + x.amountRaw, 0) / 1e6;
    report(resolved ? 'LP payout claimed. Receipts are in your journal.'
      : `Liquidity withdrawn${redeemed ? `; ${format(redeemed)} mUSDC back in your wallet` : ''}${left ? `; ${left} kept as a position you can sell` : ''}.`, 'ok');
  } catch (error) {
    if (error?.shown) return;
    const saved = error?.completed?.length ? `Saved ${error.completed.map(x => lpStepText[x.step]).join(', ')}. ` : '';
    const stepName = { claimCommitter: 'claim LP allocation', withdrawLiquidity: 'withdraw liquidity', redeemPair: 'redeem YES+NO pairs',
      claimLpResiduals: 'claim pool share', claimWinnings: 'redeem winnings' }[error?.failedStep];
    report(`${saved}${stepName ? `Stopped at "${stepName}": ` : ''}${error.message}${saved ? ' Click the same button to resume.' : ''}`, 'error');
  } finally { setBusy(false); void refreshPosition(); void refreshBalance(); }
}
function doLpWithdraw() { if (selected) return doLpExit({ marketPda: selected.marketPda }); }
function doLpClaim() { if (selected) return doLpExit({ marketPda: selected.marketPda }); }
function doVaultLpPayout() {
  const v = selectedVault;
  if (!v?.launched || !v.market) return vaultMessage('This vault has not launched a market yet.', true);
  return doLpExit({ marketPda: v.market, vaultPda: v.vaultPda, report: (text, tone) => vaultMessage(text, tone === 'error') });
}

function vaultMessage(message,failed=false){const el=$('vaultStatus');el.textContent=message;el.className='trade-status'+(failed?' error':'');}
function vaultLink(vault, hash = 'vaults') {
  const url = new URL('/', location.href);
  url.searchParams.set('vault', vault.vaultPda);
  if (vault.launched && vault.market) url.searchParams.set('market', vault.market);
  url.hash = hash;
  return url;
}

function renderLifecycle() {
  const vault = selectedVault;
  $('lifecycleActions').hidden = !vault;
  $('lifecycleProof').hidden = !vault || lifecycleProof?.vaultPda !== vault.vaultPda;
  $('lifecycleProof').replaceChildren();
  if (!$('lifecycleProof').hidden) {
    for (const entry of lifecycleProof.receipts ?? []) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(entry.signature)) continue;
      const link = document.createElement('a');
      link.className = 'mini-link';
      link.href = explorer(entry.signature);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = entry.label + ' ↗';
      $('lifecycleProof').append(link);
    }
  }
  const market = linkedMarket?.marketPda === vault?.market ? linkedMarket : null;
  const state = !vault ? -1 : vault.launched
    ? market?.resolved || market?.endTs <= Date.now() / 1000 ? 3 : market ? 2 : 1
    : vaultStatus(vault).canCommit ? 0 : 1;
  const steps = ['lifeCommit', 'lifeLaunch', 'lifeTrade', 'lifeResolve'];
  steps.forEach((id, index) => {
    const el = $(id);
    el.dataset.state = index < state ? 'complete' : '';
    if (index === state) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
  });
  $('lifeMarket').hidden = state !== 2;
  $('lifeClaim').hidden = !market?.resolved;
  $('vaultLpPayoutBtn').hidden = !(vault?.launched && market?.resolved);
  $('vaultLpPayoutNote').hidden = $('vaultLpPayoutBtn').hidden;
  if (!vault) {
    $('lifecycleStatus').textContent = 'Choose a commitment vault';
    return;
  }
  $('vaultExplorer').href = `https://solscan.io/account/${encodeURIComponent(vault.vaultPda)}?cluster=devnet`;
  $('lifeMarket').href = vaultLink(vault, 'markets');
  const result = ({1: 'YES', 2: 'NO'})[market?.winningSide];
  const opening = Number.isFinite(market?.openingPriceBps) ? ` · Opening YES ${(market.openingPriceBps / 100).toFixed(2)}%` : '';
  $('lifecycleStatus').textContent = [
    'Accepting liquidity commitments', vault.launched ? 'Launched · loading market' :
      vault.yesTotal + vault.noTotal >= vault.minTotal ? 'Funding target met · awaiting launch' : 'Commit window closed',
    'Trading on PREDICT' + opening,
    market?.resolved ? ('Resolved' + (result ? ' ' + result : '') + opening) : 'Trading closed · awaiting resolution' + opening
  ][state];
}

function renderVaults() {
  const open = vaults.filter(v => vaultStatus(v).canCommit).length;
  $('vaultCount').textContent = `${open} open · ${vaults.length} shown`;
  $('chipVaults').textContent = format(open, 0);
  $('vaultList').innerHTML = vaults.length ? vaults.map(v => {
    const state = v.launched ? 'Launched' : vaultStatus(v).canCommit ? 'Funding' : 'Closed';
    return `<button type="button" class="vault-row ${selectedVault?.vaultPda === v.vaultPda ? 'selected' : ''}" aria-pressed="${selectedVault?.vaultPda === v.vaultPda}" data-vault="${escapeHtml(v.vaultPda)}"><span><b>${escapeHtml(v.name)}</b><small>${format(v.yesTotal + v.noTotal)} / ${format(v.minTotal)} mUSDC committed</small></span><span class="pct">${state}</span></button>`;
  }).join('') : '<p class="empty">No PREDICT commitment vaults are available.</p>';
  $('vaultList').querySelectorAll('[data-vault]').forEach(button => button.addEventListener('click', () => {
    selectedVault = vaults.find(v => v.vaultPda === button.dataset.vault);
    renderVaults();
    $('vaultList').querySelector('[aria-pressed="true"]')?.focus();
    void loadLinkedMarket();
  }));
  renderVaultSelected();
}

async function loadLinkedMarket() {
  const current = ++lifecycleRequest;
  if (!selectedVault?.launched || !selectedVault.market) {
    linkedMarket = null;
    renderLifecycle();
    return;
  }
  try {
    const market = await refreshMarket(selectedVault.market);
    if (current === lifecycleRequest) linkedMarket = market;
  } catch {
    if (current === lifecycleRequest) linkedMarket = null;
  }
  if (current === lifecycleRequest) renderLifecycle();
}

async function loadLifecycleProof() {
  try {
    const response = await fetch('/api/predict/lifecycle', { signal: AbortSignal.timeout(6500) });
    if (response.ok) lifecycleProof = await response.json();
  } catch {
    // The vault and market remain readable from Devnet before a proof pack is published.
  }
  renderLifecycle();
}
function renderVaultSelected(){
 renderLifecycle();
 const v=selectedVault; $('vaultQuestion').textContent=v?.name||'Choose a commitment vault';
 $('vaultYes').textContent=v?format(v.yesTotal)+' mUSDC':'—';$('vaultNo').textContent=v?format(v.noTotal)+' mUSDC':'—';
 $('vaultTarget').textContent=v?format(v.minTotal)+' mUSDC':'—';$('vaultDeadline').textContent=v?new Date(v.commitEndTs*1000).toLocaleString():'—';
 $('vaultMeterFill').style.width=v?.minTotal > 0?Math.min(100,100*(v.yesTotal+v.noTotal)/v.minTotal)+'%':'0%';
 if (v && !$('vaultClaimPda').value) $('vaultClaimPda').value = v.vaultPda;
 if (v?.launched && !$('vaultClaimMarketPda').value) $('vaultClaimMarketPda').value = v.market;
 const odds=v?vaultOdds(v):null;
 $('vaultCrowdPrice').textContent=odds?`Crowd commitments: ${odds.yesPct.toFixed(1)}% YES / ${odds.noPct.toFixed(1)}% NO. This is funding distribution, not a quoted trading price.`:'No market-forming commitments yet. A launched market will have a separate actual pm-AMM trading price.';
 const allow=!!v && vaultStatus(v).canCommit && !!currentWallet() && !mandate()?.killed;
 $('vaultCommitBtn').disabled=busy||!allow;
 $('vaultCommitBtn').innerHTML=allow?'Commit real test liquidity ↗':(!v?'Choose an open vault ↗':!currentWallet()?'Start your test wallet first ↗':mandate()?.killed?'Session paused · no commitments':'Commitment unavailable');
 for(const [id,val] of [['vaultSideYes','yes'],['vaultSideNo','no']]){$(id).classList.toggle('selected',vaultSide===val);$(id).setAttribute('aria-pressed',String(vaultSide===val));}
}
async function loadVaults() {
  try {
    vaults = await fetchVaults();
    const requested = selectedVault?.vaultPda || new URLSearchParams(location.search).get('vault');
    selectedVault = vaults.find(v => v.vaultPda === requested) || vaults[0] || null;
    renderVaults();
    void loadLinkedMarket();
  } catch {
    $('vaultCount').textContent = 'RPC unavailable';
    vaultMessage('Vaults temporarily unavailable. Refresh to retry.', true);
  }
}
async function doVaultCommit(){if(busy)return;try{
 setBusy(true);
 const v=selectedVault,amount=Number($('vaultAmount').value),wallet=currentWallet(),side=vaultSide;
 if(!v||!vaultStatus(v).canCommit)throw Error('Select an open onchain vault');
 if(!wallet)throw Error('Create your devnet wallet first');
 if(mandate()?.killed)throw Error('This browser session is paused');
 if(!Number.isFinite(amount)||amount<1||amount>20)throw Error('Vault commitment must be 1–20 mUSDC');
 const balance=await getMusdcBalance();if(amount>balance)throw Error('Insufficient devnet mUSDC; claim test funds first');
 if(!confirm(`Commit ${amount} MOCK mUSDC to the ${side.toUpperCase()} LP side of this onchain PREDICT vault? This funds future liquidity; it is not a YES/NO position. LPs can lose value.`))return;
 setBusy(true);vaultMessage('Submitting real PREDICT Commitment Vault instruction…');
 const latest=(await fetchVaults()).find(x=>x.vaultPda===v.vaultPda);if(!latest||!vaultStatus(latest).canCommit)throw Error('Vault is no longer open');
 if(mandate()?.killed || selectedVault?.vaultPda !== v.vaultPda)throw Error('Review the active vault and session again');
 const sig=await commitToVault(v.vaultPda,side,amount);await waitForConfirmation(sig);
 writeJournal({signature:sig,kind:'VAULT_COMMIT',side,amount,wallet,marketPda:v.vaultPda,at:Date.now(),status:'ONCHAIN_CONFIRMED_NOT_SWAP'});
 vaultMessage(`Real vault commitment confirmed: ${short(sig)}. Not counted as swap volume.`);await loadVaults();
 }catch(e){vaultMessage(e.message,true);}finally{setBusy(false);renderVaultSelected();}}
async function doVaultClaim(refund=false){if(busy)return;try{
 if(!currentWallet())throw Error('Create your devnet test wallet first');
 const vaultPda=$('vaultClaimPda').value.trim(),marketPda=$('vaultClaimMarketPda').value.trim();
 if(!vaultPda||( !refund && !marketPda))throw Error('Vault PDA and launched market PDA required for LP claim; refund needs vault PDA');
 if(!confirm(refund?'Request refund ONLY if PREDICT onchain rules permit?':'Claim your onchain commitment LP allocation?'))return;
 setBusy(true);vaultMessage('Submitting PREDICT vault settlement instruction…');
 const sig=refund?await refundVaultCommit(vaultPda):await claimVaultLp(vaultPda,marketPda);await waitForConfirmation(sig);
 writeJournal({signature:sig,wallet:currentWallet(),kind:refund?'VAULT_REFUND':'LP_ALLOCATION_CLAIM',amount:0,at:Date.now(),status:'ONCHAIN_CONFIRMED_NOT_SWAP'});vaultMessage('Onchain transaction confirmed: '+short(sig));
 }catch(e){vaultMessage(e.message,true)}finally{setBusy(false);}}

function events(){
 $('lifeClaim').addEventListener('click', () => { $('claimMarketPda').value = linkedMarket.marketPda; });
 $('shareVault').addEventListener('click', async () => {
   if (!selectedVault) return;
   const link = vaultLink(selectedVault).href;
   try { await navigator.clipboard.writeText(link); vaultMessage('Vault link copied.'); }
   catch { vaultMessage(link); }
 });
 $('refreshVaults').addEventListener('click',loadVaults);
 $('vaultSideYes').addEventListener('click',()=>{vaultSide='yes';renderVaultSelected();});$('vaultSideNo').addEventListener('click',()=>{vaultSide='no';renderVaultSelected();});$('vaultCommitBtn').addEventListener('click',doVaultCommit);$('vaultClaimBtn').addEventListener('click',()=>doVaultClaim(false));$('vaultRefundBtn').addEventListener('click',()=>doVaultClaim(true));
 $('walletBtn').addEventListener('click',e=>{e.stopPropagation();toggleWalletPanel();});$('walletPanel').addEventListener('click',e=>{e.stopPropagation();const b=e.target.closest('[data-wallet]');if(b)chooseWallet(b.dataset.wallet);});$('walletBurner').addEventListener('click',()=>{toggleWalletPanel(false);createAndFund();});$('walletDisconnect').addEventListener('click',async()=>{toggleWalletPanel(false);await disconnectWallet();setStatus('Wallet disconnected.');});document.addEventListener('click',()=>toggleWalletPanel(false));document.addEventListener('keydown',e=>{if(e.key==='Escape')toggleWalletPanel(false);});onWalletChange(()=>{void refreshBalance();void refreshPosition();renderWallet();renderVaultSelected();void makeQuote({quiet:true});});$('fundBtn').addEventListener('click',createAndFund);$('restoreWalletBtn').addEventListener('click',()=>createAndFund({restore:true}));$('refreshMarkets').addEventListener('click',loadMarkets);
 $('marketSearch').addEventListener('input',e=>{marketQuery=e.target.value;renderMarkets();});
 $('marketSort').addEventListener('change',e=>{marketSort=e.target.value;renderMarkets();});
 $('marketChips').addEventListener('click',e=>{const b=e.target.closest('[data-cat]');if(!b)return;marketCat=b.dataset.cat;renderMarkets();});
 $('heroTrade').addEventListener('click',()=>{if(!heroMarket||busy)return;selected=markets.find(x=>x.marketPda===heroMarket.marketPda)||heroMarket;onMarketChange();document.getElementById('markets').scrollIntoView({behavior:'smooth'});});
 $('maxAmount').addEventListener('click',async()=>{await refreshBalance();const cap=Math.min(100,getLimits().maxSingle||100,walletBalance??0);if(!(cap>=0.1)){setStatus('No test mUSDC in this wallet. Request test funds.','error');return;}$('tradeAmount').value=String(Math.floor(cap*10)/10);document.querySelectorAll('[data-amount]').forEach(x=>x.classList.remove('chosen'));makeQuote();});
 $('sideYes').addEventListener('click',()=>{side='yes';renderSide();makeQuote();});$('sideNo').addEventListener('click',()=>{side='no';renderSide();makeQuote();});
 for(const id of ['tradeAmount','maxSingle','maxTotal','slippage'])$(id).addEventListener('change',()=>makeQuote());
 document.querySelectorAll('[data-amount]').forEach(btn=>btn.addEventListener('click',()=>{$('tradeAmount').value=btn.dataset.amount;document.querySelectorAll('[data-amount]').forEach(x=>x.classList.toggle('chosen',x===btn));makeQuote();}));
 $('agentBtn').addEventListener('click',agentSuggestion);$('tradeBtn').addEventListener('click',sendTrade);$('lpBtn').addEventListener('click',doLp);$('sellBtn').addEventListener('click',sendSell);$('sellSide').addEventListener('change',()=>makeSellQuote());$('sellAmount').addEventListener('input',()=>makeSellQuote());$('sellMax').addEventListener('click',()=>{const h=held[$('sellSide').value]||0;$('sellAmount').value=h>=100_000?String(Math.floor(h/1e4)/100):'';makeSellQuote();});$('refreshPositionBtn').addEventListener('click',()=>refreshPosition());$('lpWithdrawBtn').addEventListener('click',doLpWithdraw);$('vaultLpPayoutBtn').addEventListener('click',doVaultLpPayout);$('lpClaimBtn').addEventListener('click',doLpClaim);$('claimBtn').addEventListener('click',doClaim);
 $('armBtn').addEventListener('click', () => {
   try { startTradeSession(currentWallet(), selected?.marketPda, getLimits()); void makeQuote(); }
   catch (error) { setStatus(error.message, 'error'); }
 });
 $('killBtn').addEventListener('click', () => {
   const session = mandate();
   if (!session || session.expiresAtMs <= Date.now()) return;
   saveTradeSession({ ...session, killed: !session.killed });
   renderVaultSelected();
   void makeQuote({ quiet: true });
   setStatus(session.killed ? 'Session resumed with the same limits.' : 'Session paused. Broadcast transactions can still settle.');
 });
 $('refreshQuoteBtn').addEventListener('click', () => makeQuote());
 $('retryReceiptBtn').addEventListener('click', () => reconcileReceipts());
 window.addEventListener('storage', event => {
   if (event.key?.startsWith('kult-fuse-trade-session-v3:') || event.key === journalKey) {
     renderJournal();
     void makeQuote({ quiet: true });
   }
 });
 $('shareBtn').addEventListener('click',async()=>{if(!selected){setStatus('Select a market first','error');return;}const url=new URL(location.href);url.searchParams.set('market',selected.marketPda);try{await navigator.clipboard.writeText(url.toString());setStatus('Direct market challenge link copied','ok')}catch{setStatus('Copy this link: '+url,'error');}});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-lastRefreshAt>45_000)loadMarkets()});
}
renderWallet();renderProgress();renderJournal();events();void restoreWallet().then(refreshBalance);void refreshSlot();setInterval(refreshSlot,15000);setInterval(()=>{if(!busy&&!document.hidden){renderMarkets();renderLive();}},30000);loadStats();loadMarkets();loadVaults();void reconcileReceipts();void loadLifecycleProof();
setInterval(()=>{if(!document.hidden&&!busy){loadStats();if(selected)makeQuote({ quiet: true });loadVaults();}},30_000);

setInterval(() => {
  if (document.hidden) return;
  void reconcileReceipts();
  if (!busy && quote && Date.now() - quote.quoteAtMs > 15000) {
    $('tradeBtn').disabled = true;
    $('tradeBtn').textContent = 'Refresh expired quote';
  }
}, 3000);

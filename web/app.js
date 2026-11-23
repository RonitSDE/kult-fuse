import { DEMO_LABELS, demoSnapshot, isSyntheticState, thresholdRows } from "./experience.mjs";
// KULT Fuse dashboard. Plain DOM, no build step. All data text goes through textContent.
const $ = (s) => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
const isSig = (v) => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(v);
const money = (n, d) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n); const dec = d ?? (Math.abs(v) < 100 && v % 1 !== 0 ? 2 : 0);
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(dec)}`;
};
const pct = (p, d = 1) => (p == null ? '—' : `${(p * 100).toFixed(d)}%`);
const short = (h) => (h ? `${String(h).slice(0, 6)}…${String(h).slice(-6)}` : '—');
const words = (code) => String(code || '').replaceAll('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('data-') || k.startsWith('aria-')) n.setAttribute(k, v); else n[k] = v;
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
};
const svg = (tag, attrs = {}, text) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let state = null;
let proof = null;
let marketContext = null;
let journalData = null;
let journalFilter = 'ALL';
let sim = null; // { kind: guided|replay, index, timer? }; presentation only

const TOKEN_KEY = 'kultFuseOperatorToken';
const token = () => { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
const setToken = (t) => { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };

async function api(path, body) {
  const headers = { 'content-type': 'application/json' };
  if (token()) headers.authorization = `Bearer ${token()}`;
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast'); t.textContent = msg; t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

const explorer = (kind, value, cluster) => {
  const net = cluster || state?.integrity?.network || 'devnet';
  return `https://solscan.io/${kind}/${encodeURIComponent(value)}${net === 'mainnet-beta' ? '' : `?cluster=${encodeURIComponent(net)}`}`;
};
const txLink = (sig, label, cluster) => el('a', { href: explorer('tx', sig, cluster), target: '_blank', rel: 'noreferrer', text: label });

function permittedAt(policy, pBps) {
  if (pBps == null) return null;
  if (pBps < policy.killBelowBps) return 0;
  let t = 0; for (const s of policy.steps) { if (pBps >= s.pBps) t = s.exposureUsd; else break; }
  return Math.min(t, policy.riskCapUsd);
}

// Text with `code` spans, built without innerHTML.
function setRich(node, text) {
  node.replaceChildren();
  String(text ?? '').split(/(`[^`]+`)/).forEach((part) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) node.append(el('code', { text: part.slice(1, -1) }));
    else if (part) node.append(document.createTextNode(part));
  });
  return node;
}

/* ---------------- curve instrument ---------------- */
const G = { x0: 46, x1: 624, y0: 282, y1: 22 };
const curveScale = (policy) => {
  const top = policy.riskCapUsd * 1.18;
  return { x: (p) => G.x0 + (G.x1 - G.x0) * p, y: (usd) => G.y0 - (G.y0 - G.y1) * (usd / top) };
};

function drawCurve(policy, view) {
  const root = $('#curve');
  root.replaceChildren();
  if (!policy) return;
  const { x, y } = curveScale(policy);
  const kill = policy.killBelowBps / 10000;
  // grid + axes
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    root.append(svg('line', { class: 'grid', x1: x(p), x2: x(p), y1: G.y1, y2: G.y0 }));
    root.append(svg('text', { class: 'tick', x: x(p), y: G.y0 + 20, 'text-anchor': p === 0 ? 'start' : p === 1 ? 'end' : 'middle' }, `${p * 100}%`));
  }
  root.append(svg('line', { class: 'axis', x1: G.x0, x2: G.x1, y1: G.y0, y2: G.y0 }));
  root.append(svg('text', { class: 'tick', x: G.x0 - 8, y: y(0) + 4, 'text-anchor': 'end' }, '$0'));
  root.append(svg('text', { class: 'tick', x: G.x0 - 8, y: y(policy.riskCapUsd) + 4, 'text-anchor': 'end' }, money(policy.riskCapUsd)));
  // kill zone
  root.append(svg('rect', { class: 'killzone', x: x(0), y: G.y1, width: x(kill) - x(0), height: G.y0 - G.y1 }));
  root.append(svg('text', { class: 'killlabel', x: x(kill / 2), y: G.y1 + 18, 'text-anchor': 'middle' }, `Kill · $0`));
  // steps
  const segs = [];
  policy.steps.forEach((s, i) => {
    const from = Math.max(s.pBps / 10000, kill);
    const to = i + 1 < policy.steps.length ? policy.steps[i + 1].pBps / 10000 : 1;
    if (to > from) segs.push({ from, to, usd: Math.min(s.exposureUsd, policy.riskCapUsd) });
  });
  const activeUsd = view.killed ? null : view.permitted;
  for (const sgm of segs) {
    const on = activeUsd != null && view.p != null && view.p >= sgm.from && view.p < sgm.to + 1e-9 && sgm.usd === activeUsd;
    root.append(svg('rect', { class: `stepfill${on ? ' on' : ''}`, x: x(sgm.from), y: y(sgm.usd), width: x(sgm.to) - x(sgm.from), height: y(0) - y(sgm.usd) }));
    root.append(svg('text', { class: `steplabel${on ? ' on' : ''}`, x: (x(sgm.from) + x(sgm.to)) / 2, y: y(sgm.usd) - 8, 'text-anchor': 'middle' }, money(sgm.usd)));
  }
  let d = `M ${x(0)} ${y(0)} L ${x(segs[0]?.from ?? kill)} ${y(0)}`;
  for (const sgm of segs) d += ` L ${x(sgm.from)} ${y(sgm.usd)} L ${x(sgm.to)} ${y(sgm.usd)}`;
  root.append(svg('path', { class: 'step', d }));
  // cap
  root.append(svg('line', { class: 'cap', x1: G.x0, x2: G.x1, y1: y(policy.riskCapUsd), y2: y(policy.riskCapUsd) }));
  root.append(svg('text', { class: 'caplabel', x: x(kill) + 8, y: y(policy.riskCapUsd) - 7, 'text-anchor': 'start' }, `Hard cap ${money(policy.riskCapUsd)}`));
  // an allowed agent ask
  if (view.allowedAsk != null && view.p != null) {
    const ay = y(Math.min(view.allowedAsk, policy.riskCapUsd * 1.15));
    const right = x(view.p) > x(0.7);
    root.append(svg('line', { class: 'allowed', x1: x(view.p) - 60, x2: x(view.p) + 60, y1: ay, y2: ay }));
    root.append(svg('text', { class: 'allowedlabel', x: right ? x(view.p) - 66 : x(view.p) + 66, y: ay + 4, 'text-anchor': right ? 'end' : 'start' }, `Agent asked ${money(view.allowedAsk)} · within mandate`));
  }
  // rejected request (simulation, replay or an agent ask)
  if (view.requested != null && (view.refused || view.requested > (view.permitted ?? 0)) && view.p != null) {
    const ry = y(Math.min(view.requested, policy.riskCapUsd * 1.15));
    root.append(svg('line', { class: 'rejected', x1: x(view.p) - 60, x2: x(view.p) + 60, y1: ry, y2: ry }));
    // Keep the chart uncluttered: the accessible decision panel gives the refusal reason.
    // In particular, a refused request at the cap must not obscure the cap line label.
  }
  // needle and actual position
  if (view.p != null) {
    const nx = x(view.p);
    const needle = svg('line', { class: 'needle', x1: 0, x2: 0, y1: G.y1 - 4, y2: G.y0 });
    const head = svg('circle', { class: 'needlehead', cx: 0, cy: G.y1 - 6, r: 5 });
    const label = svg('text', { class: 'needlelabel', x: 0, y: G.y0 + 38, 'text-anchor': 'middle' }, pct(view.p));
    for (const n of [needle, head, label]) { n.style.transform = `translate(${prevNeedle ?? nx}px, 0)`; root.append(n); }
    if (view.actual != null) {
      const dot = svg('circle', { class: 'actualdot', cx: 0, cy: 0, r: 7 });
      dot.style.transform = `translate(${prevNeedle ?? nx}px, ${prevDotY ?? y(view.actual)}px)`;
      root.append(dot);
      requestAnimationFrame(() => { dot.style.transform = `translate(${nx}px, ${y(view.actual)}px)`; });
      prevDotY = y(view.actual);
    }
    requestAnimationFrame(() => { for (const n of [needle, head, label]) n.style.transform = `translate(${nx}px, 0)`; });
    prevNeedle = nx;
  }
}
let prevNeedle = null;
let prevDotY = null;

function renderMobileCurve(policy, p) {
  const root = $('#mobileCurve'); root.replaceChildren();
  if (!policy) return;
  root.append(el('p', { class: 'mobile-curve-title', text: 'Mandate thresholds · probability → maximum exposure' }));
  for (const r of thresholdRows(policy, p)) {
    root.append(el('div', { class: 'threshold', 'data-active': String(r.active), 'data-kill': String(r.kind === 'kill') },
      el('span', { text: r.label }), el('b', { text: money(r.usd) }), r.active ? el('small', { text: 'Current step' }) : null));
  }
}

/* ---------------- signal ---------------- */
function renderSignal(market, quote, policy) {
  const q = $('#heroTitle');
  if (market?.question) { q.textContent = market.question; q.dataset.empty = 'false'; }
  else { q.textContent = state?.setup?.signalError ? 'No market selected yet' : 'Loading the committed market…'; q.dataset.empty = 'true'; }
  const src = market?.kind === 'polymarket' ? 'Polymarket' : 'Kalshi via DFlow';
  const closes = market?.endDateMs ? ` · closes ${new Date(market.endDateMs).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  $('#marketMeta').textContent = `${src} · ${market?.ticker || 'YES outcome'}${closes}`;
  const p = quote?.probability;
  if (!sim) $('#probValue').textContent = p == null ? '' : `${(p * 100).toFixed(1)}%`;
  document.querySelector('.prob').classList.toggle('hidden', p == null && !sim);
  document.querySelector('.book').classList.toggle('hidden', p == null);
  $('#bid').textContent = pct(quote?.bid); $('#ask').textContent = pct(quote?.ask);
  $('#spread').textContent = quote?.spreadBps == null ? '—' : `${quote.spreadBps} bps`;
  $('#depth').textContent = quote?.depthUsd == null ? 'n/a' : money(quote.depthUsd, 0);
  $('#age').textContent = quote?.ageSec == null ? '—' : `${Math.round(quote.ageSec)}s`;
  const bar = document.querySelector('.book-bar');
  if (policy) bar.style.setProperty('--kill-at', `${policy.killBelowBps / 100}%`);
  if (quote?.bid != null) {
    $('#bookBand').style.left = `${quote.bid * 100}%`; $('#bookBand').style.width = `${Math.max(0.6, (quote.ask - quote.bid) * 100)}%`;
    $('#bookMid').style.left = `${quote.probability * 100}%`;
  }
  const quality = $('#quality');
  if (!quote) { quality.dataset.ok = 'false'; quality.textContent = state?.setup?.signalError ? 'No signal configured' : 'Waiting for a quote'; }
  else if (quote.quality) { quality.dataset.ok = 'true'; quality.textContent = 'Usable signal'; }
  else { quality.dataset.ok = 'false'; quality.textContent = `${words(quote.qualityReason)} quote · risk increases on hold`; }
  setRich($('#explain'), quote?.explain || (state?.setup?.signalError ? `Signal: ${state.setup.signalError}` : 'The signal is graded before it can raise exposure: it must be fresh, tight and deep.'));
}

/* ---------------- decision ---------------- */
function renderDecision(s) {
  const f = s.fuse; const pos = s.position || {}; const q = s.quote;
  const actual = Math.abs(Number(pos.exposureUsd || 0));
  const minMove = Number(f.policy.minRebalanceUsd || 0);
  let title = 'Holding'; let detail = 'Waiting for a usable quote on an armed mandate.'; let tone = 'idle';
  if (f.status === 'KILLED') {
    tone = actual >= 0.01 ? 'danger' : 'idle';
    title = actual >= 0.01 ? 'Killed · close pending' : 'Killed · flat';
    detail = actual >= 0.01 ? `The mandate is killed but ${money(actual)} is still open on the venue. A separate close must confirm.` : 'The venue reports no exposure. This mandate can never reopen.';
  } else if (f.status === 'PROPOSED') { tone = 'warn'; title = 'Committed, not armed'; detail = 'The policy is on-chain. The operator must arm it before the worker can trade.'; }
  else if (f.status === 'SETTLED') { title = 'Settled'; detail = 'This mandate is finished. Start a new one to trade again.'; }
  else if (!q?.quality) { tone = 'warn'; title = 'No new risk'; detail = q ? `${words(q.qualityReason)} quote, so exposure can only stay or fall. Venue holds ${money(actual)}.` : 'No current quote, so exposure can only stay or fall.'; }
  else if (f.desiredExposureUsd > actual + minMove) { tone = 'active'; title = 'Increase authorized'; detail = `The curve permits ${money(f.desiredExposureUsd)}. The worker is filling toward it on the venue.`; }
  else if (f.desiredExposureUsd < actual - minMove) { tone = 'warn'; title = 'Reducing'; detail = `The venue holds ${money(actual)}, above the permitted ${money(f.desiredExposureUsd)}. A reduce-only order is due.`; }
  else { tone = 'active'; title = 'On target'; detail = `Venue exposure ${money(actual)} matches what the curve permits.`; }
  const box = $('#decision'); box.dataset.tone = tone;
  $('#decisionTitle').textContent = title; $('#decisionDetail').textContent = detail;
  $('#decisionLabel').textContent = 'Current decision · venue state';
  $('#fuseStatus').textContent = words(f.status);
  $('#mark').textContent = pos.markPrice ? money(pos.markPrice, 2) : '—';
  $('#pnl').textContent = pos.unrealizedPnlUsd == null ? '—' : money(pos.unrealizedPnlUsd, 2);
  $('#reason').textContent = words(f.lastReasonCode || 'none');
}

/* ---------------- setup ---------------- */
function renderSetup(s) {
  const list = $('#checklist'); list.replaceChildren();
  const items = s.setup?.checklist || [];
  for (const it of items) {
    list.append(el('li', { 'data-ok': String(it.ok) }, el('span', { class: 'mark', 'aria-hidden': 'true' }),
      el('b', {}, el('span', { class: 'group', text: `${it.group} · ` }), document.createTextNode(it.label)),
      setRich(el('small'), it.ok ? 'Done' : it.hint)));
  }
  const missing = items.filter((i) => !i.ok).length;
  $('#setupTitle').textContent = missing ? `Not live yet · ${missing} step${missing === 1 ? '' : 's'} left` : 'Starting the live runtime';
  $('#setupError').textContent = s.setup?.error ? `Last start attempt: ${s.setup.error}` : '';
}

/* ---------------- receipts, proof, log ---------------- */
function renderReceipts(receipts = []) {
  $('#receiptCount').textContent = `${receipts.length} receipt${receipts.length === 1 ? '' : 's'}`;
  const root = $('#receipts'); root.replaceChildren();
  if (!receipts.length) { root.append(el('li', { class: 'empty', text: 'No fills yet. A receipt appears only when the venue position actually changes.' })); return; }
  const verified = new Set((proof?.verifiedRun?.receipts || []).map((r) => r.hash));
  for (const r of [...receipts].reverse().slice(0, 20)) {
    const delta = Number(r.filledExposureAfterUsd) - Number(r.actualExposureBeforeUsd);
    const kind = /KILL|STOP|CLOSE/.test(r.reason) ? 'kill' : delta >= 0 ? 'up' : 'down';
    const links = el('div', { class: 'links' });
    if (isSig(r.txSignature)) links.append(txLink(r.txSignature, 'Venue fill', r.venueCluster));
    const anchor = r.anchor?.signature || r.chain?.txs?.filter((t) => t.ix === 'record_fill').at(-1)?.signature;
    if (isSig(anchor)) links.append(txLink(anchor, 'Anchor on Solana'));
    const tag = verified.has(r.hash) ? el('span', { class: 'tag ok', text: 'Verified against chain' }) : r.anchor?.status === 'ANCHORED' ? el('span', { class: 'tag', text: 'Anchored · run the verifier' }) : el('span', { class: 'tag warn', text: 'Not anchored' });
    root.append(el('li', { class: 'receipt' },
      el('div', { class: 'receipt-head' }, el('b', { text: words(r.reason) }), el('span', { class: `delta ${kind}`, text: `${delta >= 0 ? '+' : '−'}${money(Math.abs(delta))}` })),
      el('small', { text: `At ${(Number(r.observedProbabilityBps) / 100).toFixed(1)}% · permitted ${money(r.desiredExposureAfterUsd)} · venue ${money(r.filledExposureAfterUsd)}` }),
      tag, links, el('code', { text: short(r.hash) })));
  }
}

const PROOF_ROWS = [
  ['program', 'Fuse program', 'account'],
  ['fuseAccount', 'Mandate account (policy hash)', 'account'],
  ['create', 'Mandate committed', 'tx'],
  ['arm', 'Armed by owner', 'tx'],
  ['target', 'Target authorized on-chain', 'tx'],
  ['venueOpen', 'Venue open fill', 'tx'],
  ['venueResize', 'Venue resize fill', 'tx'],
  ['kill', 'Kill committed on-chain', 'tx'],
  ['venueClose', 'Venue close fill', 'tx']
];
function renderProof() {
  const root = $('#proof'); root.replaceChildren();
  const live = state?.mode !== 'setup';
  for (const [k, label, kind] of PROOF_ROWS) {
    const item = k === 'program' || k === 'fuseAccount' ? proof?.[k] : proof?.transactions?.[k];
    const value = item?.value;
    const ok = Boolean(value && (kind === 'account' || isSig(value)));
    const tail = ok ? el('a', { class: 'val', href: kind === 'tx' ? explorer('tx', value, k.startsWith('venue') ? state?.position?.cluster : null) : explorer('account', value), target: '_blank', rel: 'noreferrer', text: short(value) })
      : el('span', { class: 'val', text: !live ? 'After go-live' : proof ? 'Not yet' : 'Loading…' });
    root.append(el('li', { 'data-ok': String(ok) }, el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { class: 'what', text: label }), tail));
  }
}

function renderLog(decisions = []) {
  const root = $('#log'); root.replaceChildren();
  if (!decisions.length) { root.append(el('li', { class: 'empty', text: state?.mode === 'setup' ? 'The worker starts logging once the runtime is live.' : 'No worker decisions on this mandate yet.' })); return; }
  for (const d of [...decisions].reverse().slice(0, 12)) {
    const when = new Date(d.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const li = el('li', {},
      el('div', { class: 'log-head' }, el('b', { text: words(d.outcome || 'unknown') }), el('small', { text: `${when}${d.repeatCount > 1 ? ` · ×${d.repeatCount}` : ''}` })),
      el('span', { text: d.explanation || 'No new execution.' }),
      el('small', { text: `${words(d.reason || 'none')} · target ${money(d.targetUsd)} · venue ${d.venueExposureUsd == null ? 'unavailable' : money(d.venueExposureUsd)}` }));
    if (isSig(d.venueSignature)) li.append(txLink(d.venueSignature, 'Venue transaction', state?.position?.cluster));
    root.append(li);
  }
}

/* ---------- Market intelligence: DFlow input vs Kalshi public reference ---------- */
function renderMarketContext() {
  const synthetic=isSyntheticState(state);
  if(sim || synthetic) {
    $('#marketDflowPrice').textContent='ILLUSTRATIVE';
    $('#marketKalshiPrice').textContent='NOT REQUESTED';
    $('#marketDflowDetail').textContent='This is a synthetic UI fixture, not a DFlow price.';
    $('#marketKalshiDetail').textContent='No official Kalshi data belongs to this example.';
    $('#marketComparison').textContent='SIMULATION ONLY · NOT EXECUTED · no cross-market claim';
    $('#marketComparison').dataset.status='UNAVAILABLE';
    $('#marketReferenceTime').textContent='Reference comparison is disabled during the guided demonstration.';
    return;
  }
  const ctx=marketContext;
  const d=ctx?.dflow;
  const k=ctx?.kalshi;
  $('#marketDflowPrice').textContent=d?.quote != null ? pct(d.quote) : '—';
  $('#marketDflowDetail').textContent=d ? `${d.market||'No ticker'} · ${d.usable?'usable for policy':'policy increases held'} · ${d.quoteAgeSec==null?'age unknown':`age ${Math.round(d.quoteAgeSec)}s`}` : 'No DFlow observation received';
  const observed=k?.status==='OBSERVED' && k?.orderbook?.status==='OBSERVED';
  $('#marketKalshiPrice').textContent=observed ? pct(k.orderbook.midpoint) : 'UNAVAILABLE';
  $('#marketKalshiDetail').textContent=observed ? `${k.ticker} · ${k.marketStatus} · ${k.orderbook.spreadBps} bps spread` : (k?.reason || k?.status || 'Waiting for public Kalshi reference');
  const comparison=k?.comparison;
  const status=comparison?.status || 'UNAVAILABLE';
  $('#marketComparison').dataset.status=status;
  $('#marketComparison').textContent=status==='SIMILAR' ? `Reference prices are within ${comparison.differenceBps} bps of each other. This does not verify Solana execution.`
    : status==='DIVERGENT' ? `Price divergence: ${comparison.differenceBps} bps. Verify market alignment, latency and liquidity manually; Kalshi never overrides DFlow.`
    : `Reference comparison ${words(status)}. DFlow alone supplies the policy signal; no second oracle is being claimed.`;
  $('#marketReferenceTime').textContent=k?.quoteTime ? `Kalshi observed ${new Date(k.quoteTime).toLocaleString()} · cached REST reference, never order entry` : 'Kalshi API requires no credentials for this read-only reference.';
}

/* ---------- Current-mandate decision journal; no invented execution proof ---------- */
function renderJournal() {
  const synthetic=isSyntheticState(state);
  const data=journalData;
  const summary=data?.summary || {};
  const receipts=data?.entries?.filter(e=>e.kind==='VENUE_RECEIPT') || [];
  const verified=new Set((proof?.verifiedRun?.receipts||[]).map(r=>r.hash));
  const verifiedCount=receipts.filter(r=>verified.has(r.hash)).length;
  $('#journalDecisions').textContent=data ? summary.decisions : '—';
  $('#journalRisk').textContent=data ? summary.riskHolds : '—';
  $('#journalFills').textContent=data ? summary.capturedFills : '—';
  $('#journalVerified').textContent=data ? verifiedCount : '—';
  const list=$('#journalEvents'); list.replaceChildren();
  if (!data) { list.append(el('li',{class:'empty',text:'No decision journal available; the runtime may be in setup mode.'})); return; }
  const items=(data.entries||[]).filter(e=>journalFilter==='ALL'||e.category===journalFilter).slice(0,18);
  if(!items.length) { list.append(el('li',{class:'empty',text:'No matching events for this mandate.'})); return; }
  for(const ev of items) {
    const independent=verified.has(ev.hash);
    const evidence=synthetic?'SYNTHETIC_FIXTURE':ev.kind==='VENUE_RECEIPT' && independent ? 'INDEPENDENTLY_VERIFIED' : ev.evidence;
    const li=el('li',{'data-category':ev.category},
      el('div',{class:'journal-head'},el('b',{text:words(ev.title)}),el('small',{text:ev.at>0?new Date(ev.at).toLocaleString():'Timestamp not available'})),
      el('div',{class:'journal-detail',text:ev.detail}),
      el('div',{class:'journal-evidence','data-evidence':evidence,text:words(evidence) + (ev.repeatCount>1?` · ${ev.repeatCount} repeated observations`:'' )}));
    if (isSig(ev.signature) && !synthetic) li.append(txLink(ev.signature,'View venue transaction',state?.position?.cluster));
    list.append(li);
  }
}

/* ---------------- top-level render ---------------- */
function pillFor(s) {
  if (s.mode === 'setup') return ['setup', 'Setup mode'];
  const st = s.fuse?.status;
  if (st === 'KILLED') return ['killed', 'Killed'];
  if (st === 'PROPOSED') return ['armed', 'Committed'];
  if (['ARMED', 'OPEN', 'REDUCING'].includes(st)) return ['live', st === 'ARMED' ? 'Armed' : 'Live'];
  return ['idle', words(st || 'unknown')];
}

function render(s) {
  state = s;
  const setup = s.mode === 'setup';
  const policy = setup ? s.policy : s.fuse?.policy;
  const [tone, label] = pillFor(s);
  $('#statusPill').dataset.tone = tone; $('#statusPill').textContent = label;
  $('#netLabel').textContent = `${s.integrity?.network || 'devnet'} · ${s.integrity?.perpAdapter === 'velocity' ? 'Velocity' : s.integrity?.perpAdapter || ''}`;
  $('#curveCaption').textContent = 'Committed exposure curve';
  renderSignal(s.market, s.quote, policy);
  $('#setup').classList.toggle('hidden', !setup);
  $('#decision').classList.toggle('hidden', setup && !sim);
  if (setup) renderSetup(s); else renderDecision(s);
  if (policy) {
    $('#cap').textContent = money(policy.riskCapUsd);
    $('#killLine').textContent = `${policy.killBelowBps / 100}%`;
  }
  if (!sim) {
    const pBps = s.quote ? Math.round(s.quote.probability * 10000) : setup ? null : (s.fuse?.lastProbabilityBps || null);
    const killed = !setup && s.fuse?.status === 'KILLED';
    const permitted = setup ? s.preview?.permittedUsd ?? null : killed ? 0 : s.fuse.desiredExposureUsd;
    const actual = setup ? null : Number(s.position?.exposureUsd || 0);
    $('#permitted').textContent = money(permitted);
    $('#actual').textContent = setup ? 'Not live' : money(actual);
    $('#actual').dataset.muted = String(setup);
    $('#curveMode').textContent = setup ? 'Preview · nothing executes' : 'Live';
    const ask = lastAsk && Date.now() - lastAsk.at < 20000 ? lastAsk : null;
    drawCurve(policy, { p: pBps == null ? null : pBps / 10000, permitted, actual, killed,
      requested: ask && !ask.ok ? ask.usd : null, refused: Boolean(ask && !ask.ok), allowedAsk: ask?.ok ? ask.usd : null });
    renderMobileCurve(policy, pBps == null ? null : pBps / 10000);
  }
  renderReceipts(s.receipts || []);
  renderLog(s.decisions || []);
  renderProof();
  renderMarketContext();
  renderJournal();
  const va = s.integrity?.venueAuthority;
  if (va?.limitation) $('#boundaryCopy').textContent = va.limitation;
  $('#build').textContent = `Build ${s.integrity?.buildTag || 'dev'} · ${short(s.integrity?.buildSha)} · policy ${short(setup ? s.policyHash : s.fuse?.policyHash)}`;
  renderControls();
  $('#replayBtn').classList.toggle('hidden', !(proof?.verifiedRun?.receipts?.length));
  applyPresentationMode(s);
}

function renderControls() {
  const op = Boolean(token());
  $('#operatorBtn').textContent = op ? 'Operator · sign out' : 'Operator sign-in';
  $('#controls').classList.toggle('hidden', !op || Boolean(sim) || isSyntheticState(state));
  if (!op || !state) return;
  const st = state.fuse?.status; const live = state.mode !== 'setup';
  const open = Math.abs(Number(state.position?.exposureUsd || 0)) >= 0.01;
  $('#armBtn').disabled = !live || st !== 'PROPOSED';
  $('#tickBtn').disabled = !live || !['ARMED', 'OPEN', 'REDUCING'].includes(st);
  $('#killBtn').disabled = !live || ['PROPOSED', 'KILLED', 'SETTLED'].includes(st);
  $('#settleBtn').disabled = !live || !['KILLED', 'ARMED', 'OPEN', 'REDUCING'].includes(st) || open;
  $('#newBtn').disabled = !live || !['KILLED', 'SETTLED'].includes(st);
}

/* ---------------- guided walkthrough and verified replay ---------------- */
const guideButtons = DEMO_LABELS.map((label, i) => {
  const button = el('button', { class: 'stage-button', type: 'button', text: `${i + 1}. ${label}` });
  button.addEventListener('click', () => {
    if (!sim || sim.kind !== 'guided') sim = { kind: 'guided', index: i };
    else sim.index = i;
    if (state) render(state);
  });
  $('#demoStages').append(button);
  return button;
});

function applyPresentationMode(s) {
  const preview = isSyntheticState(s);
  const guided = sim?.kind === 'guided';
  const replay = sim?.kind === 'replay';
  document.body.dataset.presentation = guided ? 'simulation' : replay ? 'replay' : preview ? 'synthetic' : 'live';
  $('#presentationBar').classList.toggle('hidden', !guided && !replay && !preview);
  $('#exitPresentation').classList.toggle('hidden', !guided && !replay);
  $('#demoGuide').classList.toggle('hidden', !guided);
  $('#simBtn').textContent = guided ? 'Exit simulation' : 'Try a guided simulation';
  $('#replayBtn').textContent = replay ? 'Exit replay' : 'Replay verified fills';
  if (guided) {
    const snap = demoSnapshot(s.mode === 'setup' ? s.policy : s.fuse?.policy, sim.index);
    $('#statusPill').dataset.tone = 'sim'; $('#statusPill').textContent = 'SIMULATION · NOT EXECUTED';
    $('#netLabel').textContent = 'Illustrative values · no network actions';
    $('#presentationTitle').textContent = 'Illustrative simulation · no orders or Solana transactions';
    $('#presentationHint').textContent = `${snap.index + 1} of ${DEMO_LABELS.length}: ${snap.label}`;
    $('#demoCounter').textContent = `Step ${snap.index + 1} of ${DEMO_LABELS.length}`;
    $('#demoPrev').disabled = snap.index === 0;
    $('#demoNext').disabled = snap.index === DEMO_LABELS.length - 1;
    $('#demoNext').textContent = snap.index === DEMO_LABELS.length - 1 ? 'Complete · exit above' : 'Next step';
    guideButtons.forEach((b, i) => { b.dataset.selected = String(i === sim.index); b.setAttribute('aria-pressed', String(i === sim.index)); });
    showSimStep(s.mode === 'setup' ? s.policy : s.fuse?.policy, snap);
    return;
  }
  if (replay) {
    const r = proof?.verifiedRun?.receipts?.[sim.index];
    $('#statusPill').dataset.tone = 'sim'; $('#statusPill').textContent = 'VERIFIED RECEIPT REPLAY';
    $('#netLabel').textContent = 'Historical data · not a live order';
    $('#presentationTitle').textContent = 'Verified historical receipt replay';
    $('#presentationHint').textContent = 'These are historical verifier records, not a new execution.';
    if (r) showReceiptStep(s.mode === 'setup' ? s.policy : s.fuse?.policy, r, sim.index, proof.verifiedRun.receipts.length);
    return;
  }
  $('.signal').classList.remove('simulating');
  if (preview) {
    $('#statusPill').dataset.tone = 'sim'; $('#statusPill').textContent = 'SYNTHETIC UI PREVIEW';
    $('#netLabel').textContent = 'Fixture only · no venue execution';
    $('#presentationTitle').textContent = 'Synthetic development preview';
    $('#presentationHint').textContent = 'All prices and venue exposures are fixtures; not real DFlow or Velocity data.';
    $('#curveMode').textContent = 'Synthetic fixture · not live';
    $('#curveCaption').textContent = 'Example exposure curve · not committed';
    $('#receiptsTitle').firstChild.textContent = 'Synthetic sample receipts ';
    $('#proofTitle').firstChild.textContent = 'No published on-chain proof ';
    $('#decisionLabel').textContent = 'Synthetic decision · fixture only';
    $('#decisionDetail').textContent = `Synthetic fixture, not a verified venue position. ${$('#decisionDetail').textContent}`;
  } else {
    $('#decisionLabel').textContent = 'Current decision · venue state';
    $('#receiptsTitle').firstChild.textContent = 'Execution receipts ';
    $('#proofTitle').firstChild.textContent = 'On-chain proof ';
  }
}

function showSimStep(policy, snap) {
  if (!policy) return;
  const { probability: p, permitted, requested, refused, killed } = snap;
  $('#probValue').textContent = `${(p * 100).toFixed(1)}%`;
  $('.prob').classList.remove('hidden');
  $('#marketMeta').textContent = 'Illustrative probability · no live market quote';
  $('#permitted').textContent = money(permitted);
  $('#actual').textContent = 'NOT EXECUTED'; $('#actual').dataset.muted = 'true';
  $('#curveMode').textContent = `SIMULATION · step ${snap.index + 1}/4`;
  $('#curveCaption').textContent = 'Illustrative mandate curve';
  $('#simNote').textContent = snap.label;
  $('.signal').classList.add('simulating');
  $('#explain').textContent = `Synthetic example. ${snap.detail}`;
  $('#decision').classList.remove('hidden'); $('#decision').dataset.tone = refused ? 'danger' : killed ? 'warn' : 'active';
  $('#decisionLabel').textContent = 'Illustrative decision · not executed';
  $('#decisionTitle').textContent = snap.title;
  $('#decisionDetail').textContent = snap.detail;
  $('#fuseStatus').textContent = killed ? 'KILLED (simulated)' : 'ACTIVE (simulated)';
  $('#mark').textContent = '—'; $('#pnl').textContent = '—'; $('#reason').textContent = snap.reason.replaceAll('_', ' ');
  drawCurve(policy, { p, permitted, actual: null, killed, requested: requested > 0 ? requested : null, refused, allowedAsk: !refused && !killed && requested > 0 ? requested : null });
  renderMobileCurve(policy, p);
}

function showReceiptStep(policy, r, i, n) {
  if (!policy) return;
  const p = Number(r.observedProbabilityBps) / 10000;
  const permitted = Number(r.desiredExposureAfterUsd);
  const actual = Number(r.filledExposureAfterUsd);
  $('#probValue').textContent = `${(p * 100).toFixed(1)}%`;
  $('#marketMeta').textContent = 'Historical verified receipt · not a live market quote';
  $('#permitted').textContent = money(permitted); $('#actual').textContent = money(actual);
  $('#actual').dataset.muted = 'false';
  $('#curveMode').textContent = `REPLAY · receipt ${i + 1}/${n}`;
  $('#curveCaption').textContent = 'Historical mandate curve';
  $('#simNote').textContent = `${words(r.reason)} · receipt ${short(r.hash)}`;
  $('.signal').classList.add('simulating');
  $('#explain').textContent = 'Historical fill from the independent verifier; playing this view does not send any order.';
  $('#decision').classList.remove('hidden'); $('#decision').dataset.tone = 'active';
  $('#decisionLabel').textContent = 'Historical receipt · verified replay';
  $('#decisionTitle').textContent = `${words(r.reason)} · historical`;
  $('#decisionDetail').textContent = `Verified record ${i + 1} of ${n}. Submitted ${money(permitted)}, venue recorded ${money(actual)}. No trade is being sent now.`;
  $('#fuseStatus').textContent = 'Historical'; $('#mark').textContent = '—'; $('#pnl').textContent = '—'; $('#reason').textContent = words(r.reason);
  drawCurve(policy, { p, permitted, actual, killed: permitted === 0 && /KILL|STOP/.test(r.reason) });
  renderMobileCurve(policy, p);
}

function stopSim() {
  if (sim?.timer) clearInterval(sim.timer);
  sim = null; prevNeedle = null; prevDotY = null;
  $('#simNote').textContent = '';
  $('#curveCaption').textContent = 'Committed exposure curve';
  if (state) render(state);
}
function startGuidedDemo() {
  if (sim?.timer) clearInterval(sim.timer);
  sim = { kind: 'guided', index: 0 };
  if (state) render(state);
}
function startVerifiedReplay() {
  if (sim?.kind === 'replay') { stopSim(); return; }
  if (sim?.timer) clearInterval(sim.timer);
  const receipts = proof?.verifiedRun?.receipts || [];
  if (!receipts.length) return;
  sim = { kind: 'replay', index: 0 };
  if (state) render(state);
  sim.timer = setInterval(() => {
    if (!sim || sim.kind !== 'replay') return;
    if (sim.index >= receipts.length - 1) { clearInterval(sim.timer); sim.timer = null; return; }
    sim.index += 1;
    if (state) render(state);
  }, reduceMotion ? 3500 : 2500);
}

/* ---------------- data loop ---------------- */
let inflight = null;
async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const s = await api('api/state');
      $('#banner').classList.add('hidden');
      render(s);
      return s;
    } catch (e) {
      $('#banner').classList.remove('hidden');
      if (!state) { $('#statusPill').dataset.tone = 'idle'; $('#statusPill').textContent = 'Offline'; }
      throw e;
    } finally { inflight = null; }
  })();
  return inflight;
}
async function loadMarketContext() {
  try { marketContext=await api('api/market/context'); }
  catch { marketContext=null; }
  if(state) renderMarketContext();
}
async function loadJournal() {
  try { journalData=await api('api/journal'); }
  catch { journalData=null; }
  if(state) renderJournal();
}
async function loadProof() {
  try { proof = await api('api/proof'); } catch { proof = null; }
  if (state) render(state);
}
async function act(path, done) {
  try { const out = await api(path, {}); await refresh(); await loadProof(); toast(done(out)); return out; }
  catch (e) { await refresh().catch(() => {}); toast(e.message, true); }
}

async function runVerifier() {
  const btn = $('#verifyBtn'); btn.disabled = true; btn.textContent = 'Verifying…';
  try {
    const v = await api('api/verify', {});
    $('#verify').classList.remove('hidden');
    $('#verifyHeadline').textContent = v.summary;
    const list = $('#verifyChecks'); list.replaceChildren();
    for (const c of v.checks || []) list.append(el('li', { 'data-ok': String(c.ok) }, el('span', {}, document.createTextNode(c.name), el('small', { text: String(c.actual ?? '').slice(0, 90) }))));
    for (const f of v.fills || []) list.append(el('li', { 'data-ok': String(f.status === 'VERIFIED') }, el('span', {}, document.createTextNode(`${f.status === 'VERIFIED' ? 'Verified' : 'Unverified'} · ${words(f.reason)} · ${money(f.positionUsd)}`), el('small', { text: f.problems?.length ? f.problems.join('; ') : `residual ${money(f.residualUsd)}` }))));
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Run verifier'; }
}

/* ---------------- be the agent ---------------- */
let lastAsk = null;
const ASK_REASONS = {
  MANDATE_NOT_ACTIVE: () => 'the mandate is not armed',
  MANDATE_EXPIRED: () => 'the mandate has expired',
  INVALID_TARGET: () => 'ask in whole dollars, zero or more',
  UNTRUSTED_OR_STALE_QUOTE: () => 'the signal is not trustworthy right now, so nothing new is allowed',
  CURVE_LIMIT_EXCEEDED: (o) => `the curve permits at most ${money(o.permittedUsd)} at this probability`,
  RISK_CAP_EXCEEDED: () => `it is over the ${money((state?.fuse?.policy || state?.policy)?.riskCapUsd)} hard cap`,
  PROPOSAL_BINDING_MISMATCH: () => 'it was written for a different mandate',
  EXPIRED_OR_FUTURE_PROPOSAL: () => 'the request is too old'
};
async function askMandate(e) {
  e.preventDefault();
  if (sim) stopSim();
  const usd = Number($('#askUsd').value);
  const out = $('#askResult');
  out.dataset.verdict = ''; out.textContent = 'Asking…';
  try {
    const r = await api(`api/agent/check?targetUsd=${encodeURIComponent($('#askUsd').value)}`);
    const ok = r.verdict === 'ALLOW_AS_PROPOSAL_ONLY';
    lastAsk = { usd, ok, at: Date.now() };
    out.dataset.verdict = ok ? 'allow' : 'refuse';
    out.replaceChildren(el('b', { text: ok ? `Allowed: ${money(usd)}.` : `Refused: ${money(usd)}.` }), document.createTextNode(' '),
      document.createTextNode(ok ? `Inside the curve${r.preview ? ' (preview: no mandate is armed yet)' : ''}. In a live run this target still has to pass the Fuse program on-chain before any order.`
        : `${(r.reasons || []).map((k) => (ASK_REASONS[k] || (() => words(k)))(r)).join('; ')}.`.replace(/^./, (c) => c.toUpperCase())));
    if (state) render(state);
  } catch (err) { out.dataset.verdict = 'refuse'; out.textContent = err.message; }
}
$('#askForm').addEventListener('submit', askMandate);

/* ---------------- wiring ---------------- */
$('#retry').addEventListener('click', () => refresh().then(loadProof).catch((e) => toast(e.message, true)));
$('#refreshMarketContext').addEventListener('click', () => loadMarketContext().catch(()=>{}));
document.querySelectorAll('.journal-filter').forEach(button=>button.addEventListener('click',()=>{
  journalFilter=button.dataset.filter;
  document.querySelectorAll('.journal-filter').forEach(x=>x.dataset.selected=String(x===button));
  renderJournal();
}));
$('#simBtn').addEventListener('click', () => sim?.kind === 'guided' ? stopSim() : startGuidedDemo());
$('#startWalkthrough').addEventListener('click', () => { startGuidedDemo(); $('.instrument').scrollIntoView({ behavior: reduceMotion ? 'instant' : 'smooth', block: 'start' }); });
$('#demoPrev').addEventListener('click', () => { if (sim?.kind === 'guided' && sim.index > 0) { sim.index -= 1; render(state); } });
$('#demoNext').addEventListener('click', () => { if (sim?.kind === 'guided' && sim.index < DEMO_LABELS.length - 1) { sim.index += 1; render(state); } });
$('#exitPresentation').addEventListener('click', stopSim);
$('#replayBtn').addEventListener('click', startVerifiedReplay);
$('#verifyBtn').addEventListener('click', runVerifier);
$('#operatorBtn').addEventListener('click', () => {
  if (token()) { setToken(''); renderControls(); toast('Signed out'); return; }
  $('#operatorError').classList.add('hidden'); $('#operatorDialog').showModal(); $('#tokenInput').focus();
});
$('#cancelOperator').addEventListener('click', () => { $('#tokenInput').value = ''; $('#operatorDialog').close(); });
$('#operatorForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setToken($('#tokenInput').value.trim());
  try { await api('api/auth', {}); $('#tokenInput').value = ''; $('#operatorDialog').close(); renderControls(); toast('Signed in as operator'); }
  catch (err) { setToken(''); $('#operatorError').textContent = err.message; $('#operatorError').classList.remove('hidden'); }
});

$('#armBtn').addEventListener('click', () => act('api/arm', () => 'Mandate armed'));
$('#tickBtn').addEventListener('click', () => act('api/tick', (o) => (o?.reason === 'AWAITING_CONFIRMATION' ? `Signal confirmed ${o.confirmationCount}/${state.fuse.policy.confirmationCount}` : o?.executed ? 'Position reconciled' : 'Observation accepted')));
$('#settleBtn').addEventListener('click', () => act('api/settle', () => 'Mandate settled'));
$('#newBtn').addEventListener('click', () => act('api/fuse/new', () => 'New mandate committed on-chain'));
$('#killBtn').addEventListener('click', () => { if (confirm('Kill this mandate? It commits a zero target on-chain and sends a close to the venue. It cannot be undone.')) act('api/kill', () => 'Kill committed. Watch for the venue close.'); });

refresh().catch(() => {});
loadProof();
loadJournal();
loadMarketContext();
setInterval(() => { if (!document.hidden && !sim) refresh().catch(() => {}); }, 5000);
setInterval(() => { if (!document.hidden) loadProof(); }, 30000);

setInterval(()=>{if(!document.hidden) loadMarketContext();},60000);
setInterval(()=>{if(!document.hidden) loadJournal();},10000);

// UI polish: header elevation on scroll and staggered section reveal. Purely presentational.
(() => {
  const top = document.getElementById('topWrap');
  if (top) {
    const onScroll = () => { top.dataset.scrolled = String(window.scrollY > 8); };
    addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const targets = [...document.querySelectorAll('main > section:not(.intro):not(.hero), main > .columns')];
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0 });
  targets.forEach((el, i) => {
    if (el.getBoundingClientRect().top < innerHeight) return; // already on screen: show immediately
    el.classList.add('reveal'); el.style.transitionDelay = `${Math.min(i, 3) * 40}ms`; io.observe(el);
  });
})();

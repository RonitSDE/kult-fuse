// Read-only release gate. It never fills missing proof fields with example data.
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;
const SHA = /^[0-9a-f]{40}$/i;

export function assessSubmission({ manifest = {}, health = {}, state = {}, proof = {}, publicUrl }) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  let origin = null;
  try { origin = new URL(publicUrl).origin; } catch { /* invalid URL */ }
  add('Public HTTPS app', Boolean(origin && origin.startsWith('https://') && origin === publicUrl), publicUrl || 'missing');
  add('Manifest, URL and health URL match', Boolean(origin && manifest.publicUrl === origin && manifest.healthUrl === `${origin}/healthz`));
  add('Live host responds with current build', health.status === 'ok' && health.service === 'kult-fuse' && health.buildSha === state.integrity?.buildSha);
  add('Commit SHA and tag are supplied', SHA.test(manifest.buildSha || '') && Boolean(manifest.buildTag) && manifest.buildTag === state.integrity?.buildTag && manifest.buildSha === state.integrity?.buildSha);
  add('Demo video supplied', /^https:\/\//.test(manifest.demoVideo || ''));
  add('Same-cluster Fuse and venue', Boolean(manifest.fuseNetwork && manifest.fuseNetwork === manifest.venueNetwork && manifest.fuseNetwork === state.integrity?.network && manifest.fuseNetwork === health.network));
  add('Actual Polymarket and Drift adapters', state.integrity?.onchain === true && state.integrity?.eventSource === 'polymarket' && state.integrity?.perpAdapter === 'drift' && state.fuse?.policy?.venue === 'DRIFT' && state.fuse?.policy?.marketId === 'SOL-PERP');
  add('Committed market and rationale', Boolean(manifest.eventMarket && manifest.eventMarket === state.market?.id && manifest.eventMarket === state.fuse?.policy?.eventMarket && String(manifest.eventToPerpThesis || '').trim().length >= 80));
  const q = state.quote;
  add('Usable live Polymarket quote displayed', Boolean(q?.source?.startsWith('polymarket:') && q.quality === true && q.ageSec >= 0 && q.ageSec <= state.fuse?.policy?.maxOracleAgeSec && q.bid >= 0 && q.ask <= 1 && q.bid <= q.ask));
  add('Onchain mandate matches host', Boolean(manifest.programId && manifest.programId === state.integrity?.programId && manifest.fuseAccount && manifest.fuseAccount === state.integrity?.fusePda && proof.fuseAccount?.value === manifest.fuseAccount));
  add('Mandate killed and venue flat', ['KILLED','SETTLED'].includes(state.fuse?.status) && Number.isFinite(state.position?.exposureUsd) && Math.abs(state.position.exposureUsd) <= 0.5);
  const txPairs = [['create','create'],['arm','arm'],['target','target'],['kill','kill'],['driftOpen','venueOpen'],['driftResize','venueResize'],['driftClose','venueClose']];
  for (const [field,live] of txPairs) {
    const sig = manifest.proofTransactions?.[field];
    add(`${field} signature matches live mandate`, SIGNATURE.test(sig || '') && proof.transactions?.[live]?.value === sig && proof.transactions?.[live]?.url?.includes(sig));
  }
  add('Three distinct venue signatures', new Set(['driftOpen','driftResize','driftClose'].map(f => manifest.proofTransactions?.[f])).size === 3);
  const receipts = state.receipts || [];
  add('Three real venue fills and anchored receipts', receipts.length >= 3 && receipts.every(r => r.fuseId === state.fuse?.id && SIGNATURE.test(r.txSignature || '') && r.anchor?.status === 'ANCHORED' && SIGNATURE.test(r.anchor.signature || '')));
  add('Verified replay only from live receipts', proof.verifiedRun?.source === 'live' && proof.verifiedRun.receipts?.length === receipts.length && receipts.length >= 3 && receipts.every((r,i) => r.hash === proof.verifiedRun.receipts[i]?.hash));
  add('Venue key limitation disclosed', state.integrity?.venueAuthority?.bound === false && manifest.authorityBound === false && manifest.venueKeyCanBypassFuse === true);
  return { ok: checks.every(c => c.ok), checks };
}

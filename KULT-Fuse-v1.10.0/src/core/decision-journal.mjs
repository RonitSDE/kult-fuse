/** Evidence-labeled, bounded public journal. Read-only projection of current mandate events. */
export function decisionCategory(d) {
  const s=String(d.outcome||'');
  if(['BLOCKED','NO_FILL','CLOSE_PENDING','CLOSE_UNKNOWN'].includes(s)) return 'RISK';
  if(s==='FILLED'||s==='CLOSED') return 'EXECUTION';
  if(s==='HOLD'||s==='KILLED_FLAT') return 'POLICY';
  return 'LIFECYCLE';
}
export function buildDecisionJournal({fuseId, decisions=[], receipts=[], verifiedHashes=[]}={}) {
  const verified=new Set(verifiedHashes);
  const current=decisions.filter(d=>d.fuseId===fuseId).slice(-60);
  const fills=receipts.filter(r=>r.fuseId===fuseId).slice(-20);
  const entries=[...current.map(d=>({
    id:String(d.id),kind:'DECISION', category:decisionCategory(d), at:Number(d.at)||0,
    title:String(d.outcome||'HOLD'), reason:String(d.reason||'UNKNOWN'), detail:String(d.explanation||'No execution claimed'),
    targetUsd:Number(d.targetUsd)||0, venueExposureUsd:d.venueExposureUsd ?? null,
    signature:d.venueSignature||null, evidence:'WORKER_LOG_ONLY',repeatCount:d.repeatCount||1
  })),...fills.map((r,i)=>({
    id:`receipt:${r.hash||i}`,kind:'VENUE_RECEIPT',category:'EXECUTION',at:Number(r.createdAt||r.observedAtMs||r.at||0),
    title:String(r.reason||'VENUE_FILL'),reason:String(r.reason||'FILL'),detail:'Captured position-change record; independent venue and chain verification required.',
    targetUsd:Number(r.desiredExposureAfterUsd)||0, venueExposureUsd:Number(r.filledExposureAfterUsd)||0,
    signature:r.txSignature||null, hash:r.hash||null,
    evidence:verified.has(r.hash)?'INDEPENDENTLY_VERIFIED':'CAPTURED_UNVERIFIED', repeatCount:1
  }))].sort((a,b)=>b.at-a.at).slice(0,70);
  return {
    mandateId:fuseId||null, source:'CURRENT_MANDATE_ONLY',
    summary:{ decisions:current.length, riskHolds:current.filter(d=>decisionCategory(d)==='RISK' ||
        (d.outcome==='HOLD' && /^(ORACLE_|VENUE_PNL_|CHAIN_|RISK_|MANDATE_)/.test(String(d.reason||'')))).length,
      capturedFills:fills.length, independentlyVerifiedFills:fills.filter(r=>verified.has(r.hash)).length,
      latestVenueExposureUsd:current.at(-1)?.venueExposureUsd ?? fills.at(-1)?.filledExposureAfterUsd ?? null },
    entries
  };
}

// PREDICT commitment vault is a first-class pm-AMM market formation primitive.
// Commitments FUND liquidity (LP), not a YES/NO winning position.
function number(v){if(v==null)return NaN;const n=typeof v?.toString==='function'?Number(v.toString()):Number(v);return Number.isFinite(n)?n:NaN;}
function textName(bytes){if(typeof bytes==='string')return bytes;try{return new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\0/g,'').trim();}catch{return 'Unnamed vault';}}
export function normalizeVault(entry){
 const a=entry?.account||entry;const pda=entry?.publicKey||entry?.vaultPda;
 if(!a||!pda)throw Error('Invalid vault account');
 const yesTotal=number(a.yesTotal)/1e6,noTotal=number(a.noTotal)/1e6,minTotal=number(a.minTotal)/1e6;
 return {collateralMint:a.collateralMint?.toString?.(),vaultPda:String(pda),name:textName(a.name),commitEndTs:number(a.commitEndTs),marketEndTs:number(a.marketEndTs),yesTotal,noTotal,minTotal,launched:!!a.launched,market:a.market?.toString?.()||null,commitCount:number(a.commitCount),vaultId:number(a.vaultId)};
}
export function vaultStatus(v,nowSec=Math.floor(Date.now()/1000)){
 if(!v||v.launched)return {canCommit:false,reason:'Market already launched'};
 if(!Number.isFinite(v.commitEndTs)||v.commitEndTs<=nowSec)return {canCommit:false,reason:'Commit window closed'};
 if(!Number.isFinite(v.minTotal)||v.minTotal<=0)return {canCommit:false,reason:'Invalid collateral target'};
 return {canCommit:true,reason:'Commitment open'};
}
export function vaultOdds(v){const total=Number(v?.yesTotal||0)+Number(v?.noTotal||0);return total>0?{yesPct:100*v.yesTotal/total,noPct:100*v.noTotal/total}:null;}

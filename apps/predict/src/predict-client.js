import * as web3 from '@solana/web3.js';
import * as splToken from '@solana/spl-token';
import * as sdk from '@pm-amm/sdk';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { assertDevnet } from '../../../src/predict/network.mjs';
import { getWallet } from './wallet.js';
import { AnchorProvider, Wallet } from '@anchor-lang/core';
import { PmAmmClient } from '@pm-amm/sdk';
import { i80f48ToNumber, priceFromReserves, estimateSwapOutput } from '@pm-amm/sdk/math';
import { SWAP_FEE_BPS } from '@pm-amm/sdk';
import { normalizeVault, vaultStatus } from '../../../src/predict/vault.mjs';
import { buildTaggedSwapIxs } from '../../../src/predict/tagged-swap.mjs';
import { marketState as sharedMarketState } from '../../../src/predict/pricing.mjs';

const PROGRAM='GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y';
const MINT='3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ';
const key='https://api.devnet.solana.com';
export const rpcUrl=import.meta.env.VITE_DEVNET_RPC || key;
if (/mainnet|mainnet-beta/i.test(rpcUrl))throw Error('Live-mainnet RPC is forbidden in this release');
export const connection=new Connection(rpcUrl, {
 commitment: 'confirmed', disableRetryOnRateLimit: true,
 fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(9000) })
});
const programId=new PublicKey(PROGRAM), mint=new PublicKey(MINT);
export { ensureWallet, getWallet, hasLegacyWallet } from './wallet.js';
let chainCheck;
export function requireDevnet() {
  chainCheck ??= assertDevnet(connection).finally(() => { chainCheck = null; });
  return chainCheck;
}
export function browserSigner() {
 const wallet=getWallet();if(!wallet)throw Error('Create a devnet wallet first');
 const provider=new AnchorProvider(connection,new Wallet(wallet),{commitment:'confirmed',preflightCommitment:'confirmed'});
 return {wallet,client:PmAmmClient.fromProvider(provider,programId,mint)};
}
const readonlyClient=PmAmmClient.readOnly(connection,programId,mint);
const num=v => v?.toNumber?.() ?? Number(v);
export function nameFromBytes(bytes) {try{return new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\0/g,'').trim();}catch{return 'Unnamed market';}}
// Rescales stored reserves from lastAccrualTs to now before pricing (see src/predict/pricing.mjs).
const marketState=(m)=>sharedMarketState(m,{i80f48ToNumber,priceFromReserves});
function yesPrice(m) {
 if (m.resolved) return null;
 if (num(m.endTs) <= Date.now()/1000) return null;
 const p=marketState(m).price;
 if(!Number.isFinite(p)||p<0||p>1)throw Error('Invalid pm-AMM spot price');
 return Math.min(1,Math.max(0,p));
}
export function normalizeEntry(entry,at=Date.now()) {
 const m=entry.account || entry;const pda=entry.publicKey || entry.marketPda;
 if (m.collateralMint?.toString()!==MINT)throw Error('Unsupported collateral: Fuse demo is devnet mUSDC only');
 return {openingPriceBps:num(m.initialPriceBps),marketPda:pda.toString(),marketId:num(m.marketId),name:nameFromBytes(m.name),endTs:num(m.endTs),startTs:num(m.startTs),resolved:!!m.resolved,winningSide:num(m.winningSide),yesMint:m.yesMint?.toString(),noMint:m.noMint?.toString(), price:yesPrice(m), observedAtMs:at, raw:m};
}
async function fetchProgramEntries(name, collateralOffset) {
  const coder = readonlyClient.accounts[name].coder.accounts;
  const rows = await connection.getProgramAccounts(programId, {
    commitment: 'confirmed',
    filters: [{ memcmp: coder.memcmp(name) }, { memcmp: { offset: collateralOffset, bytes: MINT } }]
  });
  return rows.flatMap(({ pubkey, account }) => {
    try { return [{ publicKey: pubkey, account: coder.decode(name, account.data) }]; }
    catch { return []; }
  });
}

export async function fetchMarketList() {
 const featured=(import.meta.env.VITE_FEATURED_MARKETS || '').split(',').map(s=>s.trim()).filter(Boolean);
 const now=Date.now()/1000;
 const requested=new URLSearchParams(location.search).get('market');
 if(featured.length && requested && !featured.includes(requested))featured.unshift(requested);
 if(featured.length){
   const entries=await Promise.all(featured.slice(0,8).map(async x=> {try {const pda=new PublicKey(x);const account=await readonlyClient.fetchMarket(pda);return account?{publicKey:pda,account}:null;}catch{return null;}}));
   return entries.filter(Boolean).flatMap(x=>{try{return [normalizeEntry(x)];}catch{return [];}}).filter(m=>!m.resolved && m.endTs>now);
 }
 const list=await fetchProgramEntries('market', 8 + 32 + 8);
 const active=list.map(x=>{try{return normalizeEntry(x);}catch{return null;}}).filter(x=>x && !x.resolved && x.endTs>now).sort((a,b)=>a.endTs-b.endTs).slice(0,24);
 if(requested && !active.some(x=>x.marketPda===requested)){
   try {const m=await refreshMarket(requested);if(!m.resolved && m.endTs>now)active.unshift(m);}catch{}
 }
 return active;
}
export async function refreshMarket(pda) {
 const account=await readonlyClient.fetchMarket(new PublicKey(pda));
 if(!account)throw Error('Selected PREDICT market no longer exists');
 return normalizeEntry({publicKey:new PublicKey(pda),account});
}
/**
 * PREDICT SDK's official float64 estimate of a USDC->YES/NO swap, including the
 * 2% fee on the input leg. Conservative minOutput is enforced onchain by swap.
 * An estimate is not a guarantee of execution; any divergence causes a failed
 * transaction, not a silently worse fill. Always refetch before user signs.
 */
export function exactQuote(market,direction,amount) {
 if(!market?.raw || (direction!=='usdcToYes' && direction!=='usdcToNo'))throw Error('Valid onchain market and buy direction required');
 if(market.resolved || market.endTs<=Date.now()/1000)throw Error('Market expired or resolved');
 if(market.raw.collateralMint?.toString()!==MINT)throw Error('This market does not use PREDICT devnet mUSDC');
 const raw=Math.round(amount*1e6);
 if(!Number.isSafeInteger(raw)||raw<=0)throw Error('Invalid mUSDC input');
 const state=marketState(market.raw);
 const feeRaw=Math.floor(raw*SWAP_FEE_BPS/10000);
 const netIn=raw-feeRaw;
 const est=estimateSwapOutput(state.x,state.y,state.lEff,netIn,direction==='usdcToYes'?'yes':'no');
 const quotedRaw=Math.floor(est.output);
 if(!Number.isSafeInteger(quotedRaw)||quotedRaw<1)throw Error('No safe PREDICT SDK estimate available');
 return {raw,quotedRaw,feeRaw,marketPda:market.marketPda,quoteAtMs:Date.now(),estimate:true};
}
export function minForBps(quote,bps) {
 if(!Number.isInteger(bps)||bps<10||bps>300)throw Error('Slippage must be 10–300 bps');
 const minRaw=Math.floor(quote.quotedRaw*(10000-bps)/10000);
 if(!Number.isSafeInteger(minRaw)||minRaw<1||minRaw>quote.quotedRaw)throw Error('Invalid SDK-based minimum output');
 return minRaw;
}
// Record the signed transaction ID before broadcast so retries only check status.
export async function buyPrediction(market, side, amountRaw, minOutRaw, { beforeSend, onSigned }) {
  await requireDevnet();
  const { client, wallet } = browserSigner();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const response = await fetch('/api/predict/attest', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet: wallet.publicKey.toBase58(), marketPda: market.marketPda,
      blockhash, side, amountRaw, minOutRaw }), signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) throw new Error('Trade review service is busy. Try again.');
  const { memo } = await response.json();
  if (typeof memo !== 'string' || !memo.startsWith('kult-fuse:predict:v3:')) {
    throw new Error('Trade attestation unavailable');
  }
  const ixs = await buildTaggedSwapIxs({ web3, splToken, sdk }, client, {
    marketPda: market.marketPda, authority: market.raw.authority.toString(),
    collateralMint: market.raw.collateralMint.toString()
  }, side === 'yes' ? 'usdcToYes' : 'usdcToNo', amountRaw, minOutRaw, memo);
  beforeSend();
  const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(wallet);
  const raw = tx.serialize();
  const signature = bs58.encode(tx.signature);
  onSigned(signature, lastValidBlockHeight);
  await connection.sendRawTransaction(raw, { preflightCommitment: 'confirmed', maxRetries: 2 });
  return signature;
}
export async function provideLiquidity(market,amount) {
 await requireDevnet();
 const {client}=browserSigner();return client.send.depositLiquidity(new PublicKey(market.marketPda),amount);
}
export async function claimWinnings(market) {
 await requireDevnet();
 const {client}=browserSigner();return client.send.claimWinnings(new PublicKey(market.marketPda));
}
export async function faucet() {
 await requireDevnet();
 const wallet=getWallet();if(!wallet)throw Error('Create your devnet wallet first');
 const resp=await fetch('https://pm-amm-devnet.vercel.app/api/faucet',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(12000),body:JSON.stringify({wallet:wallet.publicKey.toBase58(),role:'player'})});
 const body=await resp.json();if(!resp.ok)throw Error(body.error||`Faucet HTTP ${resp.status}`);return body;
}
export async function getMusdcBalance() {
 const wallet=getWallet();if(!wallet)return 0;
 const res=await connection.getParsedTokenAccountsByOwner(wallet.publicKey,{mint});
 return res.value.reduce((n,v)=>n+Number(v.account.data.parsed.info.tokenAmount.uiAmount||0),0);
}
export async function getOutcomeBalances(market) {
 const wallet=getWallet();if(!wallet||!market)return {yes:0,no:0};
 const tokens=await connection.getParsedTokenAccountsByOwner(wallet.publicKey,{programId:new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')});
 const find=address=>tokens.value.filter(x=>x.account.data.parsed.info.mint===address).reduce((n,x)=>n+Number(x.account.data.parsed.info.tokenAmount.uiAmount||0),0);
 return {yes:find(market.yesMint),no:find(market.noMint)};
}
export async function waitForConfirmation(sig) {
 // The SDK has already waited for confirmation on these non-swap actions.
 const status = (await connection.getSignatureStatuses([sig])).value[0];
 if (status?.err) throw new Error('Transaction failed on Solana');
 return status;
}
export const explorer=sig=>`https://solscan.io/tx/${encodeURIComponent(sig)}?cluster=devnet`;

export async function fetchVaults() {
  const featured=(import.meta.env.VITE_FEATURED_VAULTS||'').split(',').map(s=>s.trim()).filter(Boolean);
  const requested = new URLSearchParams(location.search).get('vault');
  if (requested && !featured.includes(requested)) featured.unshift(requested);
  let rows;
  if(featured.length) rows=(await Promise.all(featured.slice(0,8).map(async key=>{try {const publicKey=new PublicKey(key);const account=await readonlyClient.fetchVault(publicKey);return account?{publicKey,account}:null;}catch{return null;}}))).filter(Boolean);
  else rows=await fetchProgramEntries('commitmentVault', 8 + 32 + 8);
  return rows.map(x=>{try{return normalizeVault(x);}catch{return null;}})
    .filter(v=>v?.collateralMint === MINT)
    .sort((a,b)=> featured.length ? featured.indexOf(a.vaultPda) - featured.indexOf(b.vaultPda)
      : Number(vaultStatus(b).canCommit) - Number(vaultStatus(a).canCommit) || b.commitEndTs - a.commitEndTs).slice(0,16);
}
export async function commitToVault(vaultPda,side,amount) {
 await requireDevnet();
 if(!['yes','no'].includes(side)||!Number.isFinite(amount)||amount<1||amount>100)throw Error('Commit 1–100 test mUSDC');
 const {client}=browserSigner();return client.send.vaultCommit(new PublicKey(vaultPda),side,amount);
}
export async function refundVaultCommit(vaultPda) {
 await requireDevnet();
 const {client}=browserSigner();return client.send.refundCommit(new PublicKey(vaultPda));
}

export async function claimVaultLp(vaultPda,marketPda){
 await requireDevnet();
 const {client}=browserSigner();return client.send.claimCommitter(new PublicKey(vaultPda),new PublicKey(marketPda));
}

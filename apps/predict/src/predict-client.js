import * as web3 from '@solana/web3.js';
import * as splToken from '@solana/spl-token';
import * as sdk from '@pm-amm/sdk';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { assertDevnet } from '../../../src/predict/network.mjs';
import { getWallet } from './wallet.js';
import { AnchorProvider } from '@anchor-lang/core';
import { PmAmmClient } from '@pm-amm/sdk';
import { i80f48ToNumber, priceFromReserves, estimateSwapOutput, phi, capitalPhi } from '@pm-amm/sdk/math';
import { SWAP_FEE_BPS } from '@pm-amm/sdk';
import { normalizeVault, vaultStatus } from '../../../src/predict/vault.mjs';
import { buildTaggedSwapIxs } from '../../../src/predict/tagged-swap.mjs';
import { marketState as sharedMarketState, sellQuote } from '../../../src/predict/pricing.mjs';
import { nextLpExitStep } from '../../../src/predict/lp-exit.mjs';
import { pinWallet } from '../../../src/predict/pinned-wallet.mjs';

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
export { ensureWallet, getWallet, hasLegacyWallet, availableWallets, connectWallet, disconnectWallet, restoreWallet, onWalletChange } from './wallet.js';
let chainCheck;
export function requireDevnet() {
  chainCheck ??= assertDevnet(connection).finally(() => { chainCheck = null; });
  return chainCheck;
}
export function browserSigner() {
 const wallet=getWallet();if(!wallet)throw Error('Create a devnet wallet first');
 // wallet is either the browser test keypair or a connected extension; both implement Anchor's Wallet shape.
 const provider=new AnchorProvider(connection,wallet,{commitment:'confirmed',preflightCommitment:'confirmed'});
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
export async function buyPrediction(market, side, amountRaw, minOutRaw, hooks) {
  return tradePrediction(market, { action: 'buy', side, amountRaw, minOutRaw }, hooks);
}
export async function sellPrediction(market, side, amountRaw, minOutRaw, hooks) {
  return tradePrediction(market, { action: 'sell', side, amountRaw, minOutRaw }, hooks);
}
// One attested path for buys and sells. A sell's amountRaw is outcome tokens; its minimum is mUSDC.
async function tradePrediction(market, { action, side, amountRaw, minOutRaw }, { beforeSend, beforeBroadcast, onSigned }) {
  await requireDevnet();
  const { client, wallet } = browserSigner();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const response = await fetch('/api/predict/attest', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet: wallet.publicKey.toBase58(), marketPda: market.marketPda,
      blockhash, side, amountRaw, minOutRaw, ...(action === 'sell' ? { action } : {}) }), signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) throw new Error('Trade review service is busy. Try again.');
  const { memo } = await response.json();
  if (typeof memo !== 'string' || !memo.startsWith('kult-fuse:predict:v3:')) {
    throw new Error('Trade attestation unavailable');
  }
  const ixs = await buildTaggedSwapIxs({ web3, splToken, sdk }, client, {
    marketPda: market.marketPda, authority: market.raw.authority.toString(),
    collateralMint: market.raw.collateralMint.toString()
  }, action === 'sell' ? (side === 'yes' ? 'yesToUsdc' : 'noToUsdc') : (side === 'yes' ? 'usdcToYes' : 'usdcToNo'), amountRaw, minOutRaw, memo);
  beforeSend();
  const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  const signed = await wallet.signTransaction(tx);
  if (!signed?.signature) throw new Error('Wallet did not sign the trade');
  // The popup can stay open for a while. Recheck wallet, pause and session before anything is sent;
  // a signed transaction that is never broadcast simply expires with its blockhash.
  const signer = (signed.feePayer ?? wallet.publicKey).toBase58();
  beforeBroadcast?.(signer);
  // An extension may only add compute-budget instructions; anything else fails the server's attestation check.
  const raw = signed.serialize();
  const signature = bs58.encode(signed.signature);
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

// ---------- v2.1.3: selling, SOL for fees, liquidity exit ----------

/** Exact sell quote: outcome tokens in (human units), mUSDC out net of the 2% fee. Shape matches exactQuote. */
export function exactSellQuote(market, side, tokens) {
 if(!market?.raw)throw Error('Valid onchain market required');
 if(market.resolved || market.endTs<=Date.now()/1000)throw Error('Market expired or resolved');
 const raw=Math.floor(tokens*1e6);
 if(!Number.isSafeInteger(raw)||raw<100_000)throw Error('Sell at least 0.1 tokens');
 const q=sellQuote(marketState(market.raw),side,raw,{phi,capitalPhi});
 if(!Number.isSafeInteger(q.netRaw)||q.netRaw<1)throw Error('No safe sell estimate available');
 return {raw,quotedRaw:q.netRaw,feeRaw:q.feeRaw,marketPda:market.marketPda,quoteAtMs:Date.now(),estimate:true,action:'sell',side};
}

/** Raw (6-decimal) YES/NO balances, for selling exact amounts. */
export async function getOutcomeBalancesRaw(market, owner = getWallet()?.publicKey) {
 if(!owner||!market)return {yes:0,no:0};
 const tokens=await connection.getParsedTokenAccountsByOwner(owner,{programId:new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')});
 const find=address=>tokens.value.filter(x=>x.account.data.parsed.info.mint===address).reduce((n,x)=>n+Number(x.account.data.parsed.info.tokenAmount.amount||0),0);
 return {yes:find(market.yesMint),no:find(market.noMint)};
}

// A trade costs ~0.000005 SOL plus up to ~0.01 SOL of token-account rent the first time.
export const MIN_SOL_FOR_TRADES = 0.012;
export async function getSolBalance() {
 const wallet=getWallet();if(!wallet)return 0;
 return (await connection.getBalance(wallet.publicKey,'confirmed'))/1e9;
}
/**
 * The PREDICT faucet's SOL drip is optional and can be skipped (`sol: 0`, `solSkipped`). If the
 * wallet can't pay fees, try one devnet airdrop; otherwise report what the user must do.
 */
export async function ensureSolForFees() {
 const wallet=getWallet();if(!wallet)throw Error('Create your devnet wallet first');
 let sol=await getSolBalance();
 if(sol>=MIN_SOL_FOR_TRADES)return {ok:true,sol};
 try{
  const sig=await connection.requestAirdrop(wallet.publicKey,0.05*1e9);
  const {blockhash,lastValidBlockHeight}=await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({signature:sig,blockhash,lastValidBlockHeight},'confirmed');
  sol=await getSolBalance();
 }catch{/* devnet airdrops are often rate-limited or dry */}
 return {ok:sol>=MIN_SOL_FOR_TRADES,sol,address:wallet.publicKey.toBase58()};
}

/** The connected wallet's LP position on a market, in human units, or null. */
export async function getLpPosition(market) {
 const wallet=getWallet();if(!wallet||!market)return null;
 const pos=await readonlyClient.fetchLpPosition(new PublicKey(market.marketPda),wallet.publicKey);
 if(!pos)return null;
 const shares=BigInt(pos.shares.toString());
 return {sharesRaw:shares,hasShares:shares>0n,deposited:num(pos.collateralDeposited)/1e6};
}

/** Chain state the LP-exit planner needs, read fresh before every step. */
export async function readLpExitState(marketPda, vaultPda = null, owner = getWallet()?.publicKey) {
 if(!owner)throw Error('Create your devnet wallet first');
 if(typeof owner==='string')owner=new PublicKey(owner);
 const market=await refreshMarket(marketPda);
 const [lp,bal,commit]=await Promise.all([
  readonlyClient.fetchLpPosition(new PublicKey(marketPda),owner),
  getOutcomeBalancesRaw(market,owner),
  vaultPda?readonlyClient.fetchCommitPosition(new PublicKey(vaultPda),owner).catch(()=>null):null
 ]);
 let commitClaimable=false;
 if(commit&&!commit.claimed&&num(commit.yesAmount)+num(commit.noAmount)>0){
  const vault=await readonlyClient.fetchVault(new PublicKey(vaultPda));
  commitClaimable=Boolean(vault?.launched&&vault.market?.toString()===marketPda);
 }
 return {market,state:{resolved:market.resolved,winningSide:market.winningSide,commitClaimable,hasLp:Boolean(lp),
  lpShares:lp?BigInt(lp.shares.toString()):0n,yes:bal.yes,no:bal.no},
  deposited:lp?num(lp.collateralDeposited)/1e6:0};
}

/**
 * Run the LP exit to completion, one transaction per step. `onStep` fires as soon as each step is
 * confirmed, so the caller can save that receipt before the next popup. If a step fails, the error
 * carries `completed` and running again resumes from chain state.
 */
export async function runLpExit(marketPda, { vaultPda = null, owner = null, onStep } = {}) {
 await requireDevnet();
 // One wallet for the whole flow: reads, building and signing all use `pinned`, and the flow stops
 // if the extension's active account changes, including while a signing popup is open.
 const active=getWallet();if(!active)throw Error('Create your devnet wallet first');
 if(owner&&active.publicKey.toBase58()!==owner)throw Error('Active wallet changed. Click again to continue with this wallet.');
 const pinned=pinWallet(active,getWallet);
 const client=PmAmmClient.fromProvider(new AnchorProvider(connection,pinned,{commitment:'confirmed',preflightCommitment:'confirmed'}),programId,mint);
 const pda=new PublicKey(marketPda);
 const attempted=new Set(),completed=[];
 for(let i=0;i<6;i++){
  pinned.assertActive();
  const {state}=await readLpExitState(marketPda,vaultPda,pinned.publicKey);
  pinned.assertActive();
  const next=nextLpExitStep(state,attempted);
  if(!next)return {completed,state};
  attempted.add(next.step);
  try{
   const signature=
    next.step==='claimCommitter'?await client.send.claimCommitter(new PublicKey(vaultPda),pda):
    next.step==='withdrawLiquidity'?await client.send.withdrawLiquidity(pda,sdk.bn(state.lpShares)):
    next.step==='redeemPair'?await client.send.redeemPair(pda,next.amountRaw):
    next.step==='claimLpResiduals'?await client.send.claimLpResiduals(pda):
    await client.send.claimWinnings(pda);
   const done={step:next.step,signature,amountRaw:next.amountRaw||0};
   completed.push(done);
   onStep?.(done);
  }catch(e){
   if(next.step==='claimLpResiduals'&&sdk.mapAnchorError(e)?.name==='NoResidualsToClaim')continue;
   e.completed=completed;e.failedStep=next.step;e.wallet=pinned.publicKey.toBase58();throw e;
  }
 }
 return {completed};
}

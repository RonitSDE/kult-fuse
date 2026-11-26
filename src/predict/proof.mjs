import { createHash } from 'node:crypto';
import { DEVNET_MUSDC, PROGRAM_ID } from './policy.mjs';
import { APP_MEMO, MEMO_PROGRAM_ID } from './tagged-swap.mjs';
export const LIGHTHOUSE_PROGRAM_ID = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const DAO_AUTHORITY='4qXyczAr5DuBVaHUwmZT5Xt6hgQ6RwqBYcFGtrv8QEph';

// Minimal Base58 decoder so the independent verifier does not trust a client's
// SDK result or need to import the wallet SDK in source-only tests.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function decodeBase58(input) {
  if (!input || typeof input !== 'string') throw new Error('invalid base58');
  let num=0n;
  for (const ch of input) { const i=ALPHABET.indexOf(ch); if(i<0) throw new Error('invalid base58'); num=num*58n+BigInt(i); }
  const bytes=[];
  while(num>0n){bytes.unshift(Number(num&255n));num>>=8n;}
  for(const ch of input){if(ch==='1')bytes.unshift(0); else break;}
  return Buffer.from(bytes);
}
export function anchorIx(name) { return createHash('sha256').update(`global:${name}`).digest().subarray(0,8); }
// Confirmed against uploaded PREDICT IDL: instruction name is `swap`.
const swapDiscriminator = anchorIx('swap');
const tokenAmount = (entries, owner, mint) => (entries || []).filter(r=>r.owner===owner && r.mint===mint).reduce((n,r)=>n+BigInt(r.uiTokenAmount?.amount||'0'),0n);
function keysFrom(tx) {
  return (tx.transaction?.message?.accountKeys||[]).map(k=>typeof k==='string'?{pubkey:k,signer:false}:{pubkey:String(k.pubkey),signer:!!k.signer});
}
function programInstructions(tx) {
  const groups = [...(tx.transaction?.message?.instructions||[]), ...(tx.meta?.innerInstructions||[]).flatMap(x=>x.instructions||[])];
  return groups.map(ix=> ({programId:String(ix.programId||''), data:ix.data||'', parsed:ix.parsed, accounts:(ix.accounts||[]).map(String)}));
}
function memoText(ix) {
  if (typeof ix.parsed === 'string') return ix.parsed;
  try { return decodeBase58(ix.data).toString('utf8'); } catch { return ''; }
}
export function hasAppMemo(tx) {
  return programInstructions(tx).some((ix) => ix.programId === MEMO_PROGRAM_ID && memoText(ix) === APP_MEMO);
}
export function verifyPredictSwapTx(tx, { signature, wallet, marketPda, expectedMints, requireAppMemo = true, attestation, nowSec = Math.floor(Date.now()/1000) } = {}) {
  const err = (message) => ({ ok:false, message });
  if (!tx?.meta || tx.meta.err !== null) return err('Transaction absent, failed, or lacks meta');
  if (!Number.isFinite(tx.blockTime) || nowSec - tx.blockTime > 30*86400 || tx.blockTime > nowSec + 300) return err('Transaction time unavailable or outside accepted window');
  if(!expectedMints?.yes || !expectedMints?.no || expectedMints.yes===expectedMints.no) return err('Verified outcome mints for selected market required');
  const keys=keysFrom(tx);
  if (!keys.some(k=>k.pubkey===wallet && k.signer)) return err('Wallet was not a transaction signer');
  const ixs=programInstructions(tx);
  const isSwap = (ix) => {
    try { return ix.programId === PROGRAM_ID && decodeBase58(ix.data).subarray(0, 8).equals(swapDiscriminator); }
    catch { return false; }
  };
  const swaps = ixs.filter(isSwap);
  const swap = swaps.find(ix => ix.accounts.includes(marketPda));
  if (!swap) return err('No independently recognizable PREDICT pm-AMM swap instruction');

  let attribution = hasAppMemo(tx) ? 'SELF_DECLARED_MEMO' : 'NONE';
  let intent;
  let attestationId;
  if (attestation) {
    const message = tx.transaction.message;
    const topLevel = message.instructions;
    const memos = ixs.filter(ix => ix.programId === MEMO_PROGRAM_ID);
    // Lighthouse (immutable, assertion-only) is allowed because Phantom may add its guard
    // instructions to transactions it signs. It moves no tokens; the token-delta checks below
    // still require exactly the attested spend and outcome gain.
    const allowedPrograms = new Set([PROGRAM_ID, MEMO_PROGRAM_ID, 'ComputeBudget111111111111111111111111111111',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', LIGHTHOUSE_PROGRAM_ID]);
    if (tx.transaction.signatures?.[0] !== signature || keys[0]?.pubkey !== wallet ||
        swaps.length !== 1 || memos.length !== 1 ||
        !topLevel.some(ix => isSwap(ix)) || !topLevel.some(ix => String(ix.programId) === MEMO_PROGRAM_ID) ||
        topLevel.some(ix => !allowedPrograms.has(String(ix.programId))) ||
        ixs.filter(ix => ix.programId === PROGRAM_ID).length !== 1 ||
        topLevel.some(ix => String(ix.programId) === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' &&
          (ix.parsed?.type !== 'createIdempotent' && ix.parsed?.type !== 'create'))) {
      return err('Expected one direct PREDICT swap and one Fuse attestation');
    }
    const data = decodeBase58(swap.data);
    // Directions from the IDL: 0 UsdcToYes, 1 UsdcToNo, 2 YesToUsdc, 3 NoToUsdc. YES↔NO swaps don't count.
    if (data.length !== 25 || data[8] > 3 ||
        [wallet, marketPda, DEVNET_MUSDC, expectedMints.yes, expectedMints.no]
          .some((account, index) => swap.accounts[index] !== account)) {
      return err('PREDICT swap accounts or trade parameters do not match');
    }
    intent = {
      wallet, marketPda, blockhash: message.recentBlockhash,
      side: data[8] % 2 === 0 ? 'yes' : 'no',
      amountRaw: Number(data.readBigUInt64LE(9)), minOutRaw: Number(data.readBigUInt64LE(17)),
      ...(data[8] >= 2 ? { action: 'sell' } : {})
    };
    if (!attestation.verify(memoText(memos[0]), intent, tx.blockTime)) {
      return err('Missing, expired or mismatched Fuse attestation');
    }
    attribution = 'FUSE_API_ATTESTED';
    attestationId = memoText(memos[0]).split(':')[4];
  } else if (requireAppMemo && attribution === 'NONE') {
    return err('Swap was not sent through KULT Fuse (no self-declared app memo)');
  }

  const usdcDelta=tokenAmount(tx.meta.postTokenBalances, wallet, DEVNET_MUSDC)-tokenAmount(tx.meta.preTokenBalances, wallet, DEVNET_MUSDC);
  const delta = (mint) => tokenAmount(tx.meta.postTokenBalances, wallet, mint) - tokenAmount(tx.meta.preTokenBalances, wallet, mint);
  const selling = intent ? intent.action === 'sell' : usdcDelta > 0n;
  let outcomeMint, usdcRaw;
  if (!selling) {
    const spend=-usdcDelta;
    if (spend<=0n || spend>100000000000n || (intent && spend !== BigInt(intent.amountRaw))) {
      return err('No matching mUSDC debit for signer');
    }
    outcomeMint = intent ? expectedMints[intent.side] : [expectedMints.yes, expectedMints.no].find(mint => delta(mint) > 0n);
    if (!outcomeMint || (intent && (delta(outcomeMint) < BigInt(intent.minOutRaw) ||
        delta(expectedMints[intent.side === 'yes' ? 'no' : 'yes']) !== 0n))) {
      return err('No matching increase in selected market YES/NO mint');
    }
    usdcRaw = spend;
  } else {
    // Sell: exactly the attested outcome tokens leave the wallet, at least the signed minimum
    // of mUSDC arrives, and the other outcome is untouched.
    outcomeMint = intent ? expectedMints[intent.side] : [expectedMints.yes, expectedMints.no].find(mint => delta(mint) < 0n);
    if (!outcomeMint || (intent && (-delta(outcomeMint) !== BigInt(intent.amountRaw) ||
        delta(expectedMints[intent.side === 'yes' ? 'no' : 'yes']) !== 0n))) {
      return err('No matching decrease in selected market YES/NO mint');
    }
    if (usdcDelta<=0n || (intent && usdcDelta < BigInt(intent.minOutRaw))) return err('No matching mUSDC credit for signer');
    usdcRaw = usdcDelta;
  }
  const daoFeeRaw=tokenAmount(tx.meta.postTokenBalances, DAO_AUTHORITY, DEVNET_MUSDC)-tokenAmount(tx.meta.preTokenBalances, DAO_AUTHORITY, DEVNET_MUSDC);
  const daoFeeObservedMUsdc=daoFeeRaw>0n?Number(daoFeeRaw)/1e6:null;
  const usdc = Number(usdcRaw)/1e6;
  // Fee is 2% of the USDC leg: of the input on buys, of the gross output on sells (net = 98%).
  const feeEstimate = selling ? Math.round(Number(usdcRaw)*200/9800)/1e6 : Math.round(Number(usdcRaw)*0.02)/1e6;
  return {ok:true, signature, wallet, marketPda, outcomeMint, attribution, attestationId, side: intent?.side, action: selling ? 'sell' : 'buy',
    mUsdcSpentRaw: selling ? '0' : usdcRaw.toString(), mUsdcReceivedRaw: selling ? usdcRaw.toString() : '0', outcomeAmountRaw: (selling ? -delta(outcomeMint) : delta(outcomeMint)).toString(), spent: selling ? 0 : usdc, received: selling ? usdc : 0,
    time:tx.blockTime, evidence:'CONFIRMED_ONCHAIN_SWAP', feeEstimate, feeEvidence:'ESTIMATE_2_PERCENT_OF_USDC_LEG_NOT_PARSED_FROM_EVENTS', daoFeeObservedMUsdc, daoFeeEvidence:daoFeeRaw>0n?'OBSERVED_DAO_TOKEN_BALANCE_DELTA':'NOT_AVAILABLE'};
}
export function statsFromReceipts(receipts, finalizedOnly = false) {
  const data = receipts.filter(r => r?.ok && (finalizedOnly
    ? r.evidence === 'FINALIZED_ONCHAIN_SWAP' && r.attribution === 'FUSE_API_ATTESTED'
    : r.evidence === 'CONFIRMED_ONCHAIN_SWAP'));
  const wallets=new Set(data.map(r=>r.wallet));
  const counts=new Map(); data.forEach(r=>counts.set(r.wallet, (counts.get(r.wallet)||0)+1));
  return { uniqueTradingWallets:wallets.size, confirmedSwaps:finalizedOnly ? 0 : data.length, finalizedSwaps:finalizedOnly ? data.length : 0, mUsdcVolume:Number(data.reduce((n,r)=>n+Number(r.spent||0)+Number(r.received||0),0).toFixed(6)), buys:data.filter(r=>(r.action||'buy')==='buy').length, sells:data.filter(r=>r.action==='sell').length, repeatTraders:[...counts.values()].filter(n=>n>=2).length, feeEstimationMUsdc:Number(data.reduce((n,r)=>n+Number(r.feeEstimate||0),0).toFixed(6)), feeEvidence:'ESTIMATE_NOT_EXACT_CHAIN_FEE_TRANSFER', observedDaoFeesMUsdc:data.some(r=>Number.isFinite(r.daoFeeObservedMUsdc))?Number(data.reduce((n,r)=>n+(r.daoFeeObservedMUsdc||0),0).toFixed(6)):null, daoFeeTransactions:data.filter(r=>Number.isFinite(r.daoFeeObservedMUsdc)).length, network:'devnet', unit:'mUSDC', audited:false, receipts:data.slice(-30).reverse().map(({signature,wallet,marketPda,spent,received,action,time,side,attribution,slot})=>({signature,wallet,marketPda,spent,received,action:action||'buy',time,side,attribution,slot})) };
}

'use strict';
// Manual resolution: requires builder wallet and explicit evidence stored outside chain.
// NO automation or adjudication implied: human resolver remains trusted.
const fs=require('node:fs');
const { Connection,Keypair,PublicKey }=require('@solana/web3.js');
const { AnchorProvider,Wallet }=require('@anchor-lang/core');
const { PmAmmClient }=require('@pm-amm/sdk');
async function main(){
 const keypath=process.env.PREDICT_BUILDER_KEYPAIR_PATH, market=process.env.PREDICT_RESOLVE_MARKET;
 const side=process.env.PREDICT_RESOLVE_SIDE;
 if(!keypath||!market||!['yes','no'].includes(side)||!process.env.PREDICT_RESOLUTION_EVIDENCE_URL)throw Error('Require wallet path, market PDA, side, external evidence URL');
 if(!/^https:\/\//.test(process.env.PREDICT_RESOLUTION_EVIDENCE_URL))throw Error('Use HTTPS evidence');
 const rpc=process.env.PREDICT_DEVNET_RPC||'https://api.devnet.solana.com';if(/mainnet/i.test(rpc))throw Error('mainnet refused');
 const conn=new Connection(rpc,'confirmed'),kp=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypath,'utf8'))));
 await (await import('../../../src/predict/network.mjs')).assertDevnet(conn);
 const client=PmAmmClient.fromProvider(new AnchorProvider(conn,new Wallet(kp),{commitment:'confirmed'}),new PublicKey('GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y'),new PublicKey('3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ'));
 const pda=new PublicKey(market),m=await client.fetchMarket(pda);
 if(!m || m.collateralMint.toBase58()!=='3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ')throw Error('PREDICT Devnet mUSDC market required');
 if(m.resolved)throw Error('Already resolved');
 if(!m.authority.equals(kp.publicKey))throw Error('Builder wallet is not the recorded market authority');
 if(Number(m.endTs.toString())>=Date.now()/1000)throw Error('Market not expired');
 const sig=await client.send.resolveMarket(pda,side);
 console.log(JSON.stringify({market,side,signature:sig,evidence:process.env.PREDICT_RESOLUTION_EVIDENCE_URL,trustModel:'MANUAL_RESOLUTION',explorer:`https://solscan.io/tx/${sig}?cluster=devnet`},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});

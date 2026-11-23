'use strict';
// Builder-only CLI. Creates a real devnet pm-AMM market with real mock-USDC liquidity.
const fs=require('node:fs');
const { Connection, Keypair, PublicKey }=require('@solana/web3.js');
const { AnchorProvider, Wallet }=require('@anchor-lang/core');
const { PmAmmClient }=require('@pm-amm/sdk');
const PROGRAM_ID=new PublicKey('GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y');
const COLLATERAL=new PublicKey('3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ');
async function main(){
 if(process.env.SOLANA_CLUSTER && process.env.SOLANA_CLUSTER!=='devnet') throw Error('Devnet only');
 const keypath=process.env.PREDICT_BUILDER_KEYPAIR_PATH;
 if(!keypath) throw Error('Set PREDICT_BUILDER_KEYPAIR_PATH (do not commit wallet)');
 const keypair=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypath,'utf8'))));
 const name=(process.env.PREDICT_MARKET_QUESTION||'').trim();
 const durationSecs=Number(process.env.PREDICT_MARKET_DURATION_SEC||'3600');
 const depositUsdc=Number(process.env.PREDICT_MARKET_LIQUIDITY_MUSDC||'50');
 const priceBps=Number(process.env.PREDICT_MARKET_SEED_BPS||'5000');
 if(Buffer.byteLength(name)<1||Buffer.byteLength(name)>64) throw Error('Market question must be 1–64 bytes');
 if(!Number.isInteger(durationSecs)||durationSecs<300||durationSecs>30*86400)throw Error('Duration out of range');
 if(!Number.isFinite(depositUsdc)||depositUsdc<20||depositUsdc>1000)throw Error('Deposit 20–1000 mUSDC');
 if(!Number.isInteger(priceBps)||priceBps<100||priceBps>9900)throw Error('Seed bps out of range');
 const rpc=process.env.PREDICT_DEVNET_RPC||'https://api.devnet.solana.com';
 if(/mainnet/i.test(rpc)) throw Error('Mainnet RPC refused');
 const connection=new Connection(rpc,'confirmed');
 await (await import('../../../src/predict/network.mjs')).assertDevnet(connection);
 const provider=new AnchorProvider(connection,new Wallet(keypair),{commitment:'confirmed'});
 const client=PmAmmClient.fromProvider(provider,PROGRAM_ID,COLLATERAL);
 const out=await client.send.createMarket({name,durationSecs,initialPriceBps:priceBps,depositUsdc});
 console.log(JSON.stringify({network:'devnet',...out,marketName:name,creator:keypair.publicKey.toBase58(),resolution:'MANUAL_AUTHORITY_AFTER_EXPIRY',explorer:`https://solscan.io/tx/${out.signature}?cluster=devnet`},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

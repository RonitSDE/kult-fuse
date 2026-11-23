'use strict';
// Real devnet PREDICT Commitment Vault. Creator manages market launch and
// manual resolution; commits buy LP funding exposure, not a YES/NO contract.
const fs=require('node:fs');
const {Connection,Keypair,PublicKey}=require('@solana/web3.js');
const {AnchorProvider,Wallet}=require('@anchor-lang/core');
const {PmAmmClient}=require('@pm-amm/sdk');
async function main(){
 const key=process.env.PREDICT_BUILDER_KEYPAIR_PATH;if(!key)throw Error('Builder keypair file required');
 const name=(process.env.PREDICT_VAULT_QUESTION||'').trim(),commitDurationSecs=Number(process.env.PREDICT_VAULT_COMMIT_SEC||'600'),marketDurationSecs=Number(process.env.PREDICT_MARKET_DURATION_SEC||'3600'),minTotalUsdc=Number(process.env.PREDICT_VAULT_TARGET_MUSDC||'50');
 if(!name||Buffer.byteLength(name)>64)throw Error('Name must be 1–64 bytes');
 if(!Number.isInteger(commitDurationSecs)||commitDurationSecs<60||commitDurationSecs>86400)throw Error('Invalid commit window');
 if(!Number.isInteger(marketDurationSecs)||marketDurationSecs<300)throw Error('Invalid market duration');
 if(!Number.isFinite(minTotalUsdc)||minTotalUsdc<2||minTotalUsdc>1000)throw Error('Invalid mUSDC LP target');
 const rpc=process.env.PREDICT_DEVNET_RPC||'https://api.devnet.solana.com';if(/mainnet/i.test(rpc))throw Error('Mainnet refused');
 const kp=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(key,'utf8'))));
 const conn=new Connection(rpc,'confirmed');
 await (await import('../../../src/predict/network.mjs')).assertDevnet(conn);
 const client=PmAmmClient.fromProvider(new AnchorProvider(conn,new Wallet(kp),{commitment:'confirmed'}),new PublicKey('GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y'),new PublicKey('3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ'));
 const out=await client.send.createVault({name,commitDurationSecs,marketDurationSecs,minTotalUsdc});
 console.log(JSON.stringify({network:'devnet',...out,collateral:'MOCK_USDC_ONLY',purpose:'CROWDFUNDED_LP_LIQUIDITY_NOT_BETS'},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});

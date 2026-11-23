'use strict';
// Launcher wallet pays account rent. Do not ask an auto-funded browser burner to
// shoulder market creation/rent unexpectedly.
const fs=require('node:fs');
const {Connection,Keypair,PublicKey}=require('@solana/web3.js');
const {AnchorProvider,Wallet}=require('@anchor-lang/core');
const {PmAmmClient}=require('@pm-amm/sdk');
async function main(){
 const key=process.env.PREDICT_BUILDER_KEYPAIR_PATH, vault=process.env.PREDICT_VAULT_PDA;
 if(!key||!vault)throw Error('PREDICT_BUILDER_KEYPAIR_PATH and PREDICT_VAULT_PDA required');
 const rpc=process.env.PREDICT_DEVNET_RPC||'https://api.devnet.solana.com';if(/mainnet/i.test(rpc))throw Error('mainnet refused');
 const kp=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(key,'utf8'))));
 const conn=new Connection(rpc,'confirmed');
 await (await import('../../../src/predict/network.mjs')).assertDevnet(conn);
 const client=PmAmmClient.fromProvider(new AnchorProvider(conn,new Wallet(kp),{commitment:'confirmed'}),new PublicKey('GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y'),new PublicKey('3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ'));
 const pda=new PublicKey(vault),state=await client.fetchVault(pda);if(!state)throw Error('Missing onchain vault');
 if(state.collateralMint.toBase58()!=='3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ')throw Error('PREDICT Devnet mUSDC vault required');
 if(BigInt(state.yesTotal.toString())+BigInt(state.noTotal.toString())<BigInt(state.minTotal.toString()))throw Error('Vault funding target not met');
 if(state.launched)throw Error('Already launched');
 if(Number(state.commitEndTs.toString())>Date.now()/1000)throw Error('Commit window has not ended');
 const result=await client.send.launchVaultMarket(pda);
 console.log(JSON.stringify({network:'devnet',vault,...result},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});

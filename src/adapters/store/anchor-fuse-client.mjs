import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const REASONS = {
  INITIAL_OPEN: 1, PROBABILITY_STEP_UP: 2, PROBABILITY_STEP_DOWN: 3,
  RISK_CAP_CLAMP: 4, KILL_PROBABILITY: 5, LOSS_STOP: 6,
  EXPIRY_CLOSE: 7, OWNER_CANCEL: 8, SETTLEMENT: 9, NOOP: 10,
  ORACLE_STALE: 10, ORACLE_WIDE: 10, RECONCILE: 10, EMERGENCY_KILL: 11
};

function bytes32FromText(text) { return [...crypto.createHash('sha256').update(String(text)).digest()]; }
function bytes16FromText(text) { return bytes32FromText(text).slice(0,16); }
function hex32(hex) { const b=Buffer.from(hex,'hex'); if(b.length!==32) throw new Error('expected 32-byte hex'); return [...b]; }

/**
 * Thin Anchor client for the KULT Fuse program. It intentionally does not own business logic.
 * The worker computes targets; the program commits authorization, bounds and receipts.
 */
export class AnchorFuseClient {
  constructor(env=process.env) { this.env=env; }

  async init() {
    const [anchor, web3] = await Promise.all([import('@coral-xyz/anchor'), import('@solana/web3.js')]);
    const idlPath=this.env.FUSE_IDL_PATH || './contracts/fuse-anchor/target/idl/kult_fuse.json';
    const idl=JSON.parse(await fs.readFile(idlPath,'utf8'));
    const secret=JSON.parse(this.env.FUSE_AUTHORITY_PRIVATE_KEY_JSON || this.env.FUSE_EXECUTION_PRIVATE_KEY_JSON || '[]');
    if(!Array.isArray(secret)||secret.length<32) throw new Error('FUSE_AUTHORITY_PRIVATE_KEY_JSON missing');
    const keypair=web3.Keypair.fromSecretKey(Uint8Array.from(secret));
    const connection=new web3.Connection(this.env.SOLANA_RPC_URL,this.env.SOLANA_COMMITMENT||'confirmed');
    const wallet=new anchor.Wallet(keypair);
    const provider=new anchor.AnchorProvider(connection,wallet,{commitment:this.env.SOLANA_COMMITMENT||'confirmed'});
    const idlProgramId=new web3.PublicKey(idl.address);
    if(this.env.FUSE_PROGRAM_ID){
      const configured=new web3.PublicKey(this.env.FUSE_PROGRAM_ID);
      if(!configured.equals(idlProgramId)) throw new Error(`FUSE_PROGRAM_ID ${configured.toBase58()} does not match built IDL address ${idlProgramId.toBase58()}`);
    }
    this.anchor=anchor;this.web3=web3;this.wallet=wallet;this.provider=provider;
    this.program=new anchor.Program(idl,provider);
    this.programId=this.program.programId;
    if(this.env.FUSE_PDA) this.fusePda=new web3.PublicKey(this.env.FUSE_PDA);
    return this;
  }

  async ensure(){if(!this.program)await this.init();}
  bn(v){return new this.anchor.BN(String(Math.trunc(v)));}
  reason(name){return REASONS[name]||10;}

  async deriveFusePda(ownerPubkey, fuseId){
    await this.ensure();
    const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(fuseId));
    return this.web3.PublicKey.findProgramAddressSync([Buffer.from('fuse'),ownerPubkey.toBuffer(),b],this.programId)[0];
  }

  async initFuse({fuseId, owner, policy, agent, executionAuthority, oracleAuthority}){
    await this.ensure();
    const ownerPk=owner||this.wallet.publicKey;
    const fuse=await this.deriveFusePda(ownerPk,fuseId);
    const params={
      agent:new this.web3.PublicKey(agent), executionAuthority:new this.web3.PublicKey(executionAuthority), oracleAuthority:new this.web3.PublicKey(oracleAuthority),
      eventMarket:bytes32FromText(policy.eventMarket), outcomeId:bytes16FromText(policy.outcomeId), oracleKind:1,
      curveHash:hex32((await import('../../core/policy.mjs')).policyHash(policy)), curveVersion:policy.version,
      stepCount:policy.steps.length,
      stepThresholdsBps:[...policy.steps.map(s=>s.pBps),0,0,0,0,0].slice(0,5),
      stepExposuresUsd:[...policy.steps.map(s=>this.bn(s.exposureUsd)),this.bn(0),this.bn(0),this.bn(0),this.bn(0),this.bn(0)].slice(0,5),
      riskCapUsd:this.bn(policy.riskCapUsd), maxLeverageBps:policy.maxLeverageBps, killProbabilityBps:policy.killBelowBps,
      hysteresisBps:policy.hysteresisBps, maxOracleAgeSec:policy.maxOracleAgeSec, lossStopUsd:this.bn(policy.lossStopUsd||0),
      expiryTs:this.bn(policy.expiryTs), venue:1, marketId:bytes32FromText(policy.marketId)
    };
    const sig=await this.program.methods.initFuse(this.bn(fuseId),params).accounts({owner:ownerPk,fuse,systemProgram:this.web3.SystemProgram.programId}).rpc();
    this.fusePda=fuse;return{fuse:fuse.toBase58(),signature:sig};
  }

  async fetch(){await this.ensure();if(!this.fusePda)throw new Error('FUSE_PDA required');return this.program.account.fuseAccount.fetch(this.fusePda);}
  async arm(){await this.ensure();return this.program.methods.armFuse().accounts({owner:this.wallet.publicKey,fuse:this.fusePda}).rpc();}
  async acceptObservation({pBps,markPrice,sequence,observedTs}){await this.ensure();return this.program.methods.acceptObservation(pBps,this.bn(markPrice),this.bn(sequence),this.bn(observedTs)).accounts({oracleAuthority:this.wallet.publicKey,fuse:this.fusePda}).rpc();}
  async setTarget({targetUsd,nonce,reason}){await this.ensure();return this.program.methods.setTarget(this.bn(targetUsd),this.bn(nonce),this.reason(reason)).accounts({executionAuthority:this.wallet.publicKey,fuse:this.fusePda}).rpc();}
  async killProbability(){await this.ensure();return this.program.methods.triggerProbabilityKill().accounts({executionAuthority:this.wallet.publicKey,fuse:this.fusePda}).rpc();}
  async killAuthorized(reason){await this.ensure();return this.program.methods.triggerAuthorizedKill(this.reason(reason)).accounts({executionAuthority:this.wallet.publicKey,fuse:this.fusePda}).rpc();}
  async recordFill({filledExposureUsd,venueRef,receiptHash,nonce,reason}){await this.ensure();return this.program.methods.recordFill(this.bn(filledExposureUsd),bytes32FromText(venueRef||''),hex32(receiptHash),this.bn(nonce),this.reason(reason)).accounts({executionAuthority:this.wallet.publicKey,fuse:this.fusePda}).rpc();}
  async settle(){await this.ensure();return this.program.methods.settleFuse().accounts({owner:this.wallet.publicKey,fuse:this.fusePda}).rpc();}
}

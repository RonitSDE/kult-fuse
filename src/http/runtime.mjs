import crypto from 'node:crypto';
import { FileStore } from '../adapters/store/file-store.mjs';
import { ManualEventSource } from '../adapters/event/manual-event.mjs';
import { DFlowEventSource } from '../adapters/event/dflow-event.mjs';
import { makePerpAdapter } from '../adapters/perp/factory.mjs';
import { defaultDemoPolicy, policyHash, validatePolicy } from '../core/policy.mjs';
import { initialFuse } from '../core/state.mjs';
import { FuseEngine } from '../worker/fuse-engine.mjs';
import { verifyFuse } from '../core/verifier.mjs';
import { replayPolicy } from '../core/replay.mjs';
import { AnchorFuseClient } from '../adapters/store/anchor-fuse-client.mjs';

export class Runtime {
  constructor(env = process.env) {
    this.env = env;
    this.mode = (env.KULT_FUSE_MODE || 'demo').toLowerCase();
    this.store = new FileStore(env.DATA_DIR || './.data');
    this.manualEvent = new ManualEventSource({ initialProbability: 0.61 });
  }

  async init() {
    await this.store.init();
    let fuse = await this.store.read('fuse');
    if (!fuse) fuse = this.newFuse();
    this.receipts = await this.store.read('receipts', []);
    this.perp = await makePerpAdapter(this.env);
    this.eventSource = this.mode === 'live'
      ? new DFlowEventSource({ baseUrl: this.env.DFLOW_BASE_URL, apiKey: this.env.DFLOW_API_KEY, marketMint: this.env.DFLOW_MARKET_MINT })
      : this.manualEvent;
    this.chainHooks = await this.makeChainHooks();
    this.bindEngine(fuse);
    await this.persist(fuse);
    return this;
  }

  newFuse(policy = null) {
    const next = policy || defaultDemoPolicy();
    if (!policy && this.mode === 'live') {
      next.eventMarket = this.env.DFLOW_MARKET_MINT || next.eventMarket;
      next.venue = (this.env.PERP_ADAPTER || 'flash').toUpperCase();
      next.marketId = this.env.PERP_SYMBOL || 'SOL-PERP';
    }
    validatePolicy(next);
    return initialFuse({ id: `fuse_${crypto.randomBytes(5).toString('hex')}`, policy: next, policyHash: policyHash(next) });
  }

  async makeChainHooks() {
    if (String(this.env.FUSE_ONCHAIN || '0') !== '1') return null;
    if (!this.env.FUSE_PDA) throw new Error('FUSE_ONCHAIN=1 requires FUSE_PDA');
    const mk = async (key) => { const c=new AnchorFuseClient({ ...this.env, FUSE_AUTHORITY_PRIVATE_KEY_JSON:key }); await c.init(); return c; };
    const owner=await mk(this.env.FUSE_OWNER_PRIVATE_KEY_JSON);
    const oracle=await mk(this.env.FUSE_ORACLE_PRIVATE_KEY_JSON);
    const exec=await mk(this.env.FUSE_EXECUTION_PRIVATE_KEY_JSON);
    return {
      arm:()=>owner.arm(), settle:()=>owner.settle(),
      acceptObservation:(x)=>oracle.acceptObservation(x),
      setTarget:(x)=>exec.setTarget(x), killProbability:()=>exec.killProbability(), killAuthorized:(r)=>exec.killAuthorized(r),
      recordFill:(x)=>exec.recordFill(x)
    };
  }

  bindEngine(fuse) {
    this.engine = new FuseEngine({
      fuse,
      eventSource: this.eventSource,
      perpAdapter: this.perp,
      persist: async (f) => this.persist(f),
      appendReceipt: async (r) => { this.receipts.push(r); await this.store.write('receipts', this.receipts); },
      chainHooks: this.chainHooks
    });
  }

  async persist(fuse) { await this.store.write('fuse', fuse); }

  async reset() {
    if (this.mode === 'live') throw new Error('reset is disabled in live mode');
    await this.store.remove('fuse');
    await this.store.remove('receipts');
    this.receipts = [];
    this.perp = await makePerpAdapter({ ...this.env, PERP_ADAPTER: 'paper' });
    this.eventSource = this.manualEvent = new ManualEventSource({ initialProbability: 0.61 });
    const fuse = this.newFuse();
    this.chainHooks = await this.makeChainHooks();
    this.bindEngine(fuse);
    await this.persist(fuse);
    return this.getState();
  }

  async getState() {
    const position = await this.perp.getPosition();
    return { mode: this.mode, integrity: this.integrity(), fuse: this.engine.snapshot(), position, receipts: this.receipts };
  }


  integrity() {
    const onchain = String(this.env.FUSE_ONCHAIN || '0') === '1';
    const adapter = (this.env.PERP_ADAPTER || 'paper').toLowerCase();
    return {
      onchain,
      network: this.env.SOLANA_CLUSTER || 'devnet',
      perpAdapter: adapter,
      eventSource: this.mode === 'live' ? 'dflow' : 'manual-simulation',
      programId: this.env.FUSE_PROGRAM_ID || null,
      fusePda: this.env.FUSE_PDA || null,
      buildTag: this.env.BUILD_TAG || 'dev',
      buildSha: this.env.BUILD_SHA || 'DEV_UNSET',
      publicUrl: this.env.PUBLIC_DEMO_URL || null
    };
  }

  proof() {
    const cluster = this.env.SOLANA_CLUSTER || 'devnet';
    const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${encodeURIComponent(cluster)}`;
    const base = this.env.SOLSCAN_BASE_URL || 'https://solscan.io';
    const link = (kind, value) => value ? `${base}/${kind}/${value}${suffix}` : null;
    return {
      integrity: this.integrity(),
      program: { value: this.env.FUSE_PROGRAM_ID || null, url: link('account', this.env.FUSE_PROGRAM_ID) },
      fuseAccount: { value: this.env.FUSE_PDA || null, url: link('account', this.env.FUSE_PDA) },
      transactions: {
        create: { value: this.env.PROOF_CREATE_TX || null, url: link('tx', this.env.PROOF_CREATE_TX) },
        arm: { value: this.env.PROOF_ARM_TX || null, url: link('tx', this.env.PROOF_ARM_TX) },
        kill: { value: this.env.PROOF_KILL_TX || null, url: link('tx', this.env.PROOF_KILL_TX) },
        flashOpen: { value: this.env.PROOF_FLASH_OPEN_TX || null, url: link('tx', this.env.PROOF_FLASH_OPEN_TX) },
        flashResize: { value: this.env.PROOF_FLASH_RESIZE_TX || null, url: link('tx', this.env.PROOF_FLASH_RESIZE_TX) },
        flashClose: { value: this.env.PROOF_FLASH_CLOSE_TX || null, url: link('tx', this.env.PROOF_FLASH_CLOSE_TX) }
      }
    };
  }

  async setDemoProbability(p) {
    if (this.mode === 'live') throw new Error('manual probability disabled in live mode');
    this.manualEvent.setProbability(p);
    return { probability: this.manualEvent.probability };
  }

  async tick() { return this.engine.tick(); }
  async arm() { return this.engine.arm(); }
  async chaosShock() {
    if (this.mode === 'live') throw new Error('chaos shock is a clearly-labeled demo simulation and is disabled in live mode');
    this.manualEvent.setProbability(0.28);
    const result = await this.engine.tick();
    return { simulated: true, label: 'MARKET_SHOCK', fromBps: 7100, toBps: 2800, result };
  }
  async kill() { return this.engine.kill(); }
  async settle() { return this.engine.settle(); }
  async verify() { return verifyFuse({ fuse: this.engine.snapshot(), receipts: this.receipts }); }
  replay(probabilitiesBps) { return replayPolicy(this.engine.fuse.policy, probabilitiesBps); }
}

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { FileStore } from '../adapters/store/file-store.mjs';
import { DFlowEventSource } from '../adapters/event/dflow-event.mjs';
import { DEFAULT_POLYMARKET_MARKET, PolymarketEventSource } from '../adapters/event/polymarket-event.mjs';
import { makePerpAdapter } from '../adapters/perp/factory.mjs';
import { policyHash, validatePolicy } from '../core/policy.mjs';
import { initialFuse } from '../core/state.mjs';
import { FuseEngine } from '../worker/fuse-engine.mjs';
import { verifyFuse } from '../core/verifier.mjs';
import { AnchorFuseClient } from '../adapters/store/anchor-fuse-client.mjs';

const TERMINAL = ['KILLED', 'SETTLED'];

// Live chain and venue signatures win. Pinned PROOF_* env values are only a fallback
// for a process whose local receipt log has not yet recorded that transaction.
export function proofTransactions({ env = {}, chain = null, fuse = null, receipts = [] } = {}) {
  const txs = fuse?.chainTxs || [];
  const lastIx = (pred) => [...txs].reverse().find(pred)?.signature || null;
  const lastReceipt = (pred) => [...receipts].reverse().find((r) => pred(r) && r.txSignature)?.txSignature || null;
  const pick = (live, pinned) => live || pinned || null;
  return {
    create: pick(chain?.createTx || lastIx((t) => t.ix === 'init_fuse'), env.PROOF_CREATE_TX),
    arm: pick(lastIx((t) => t.ix === 'arm_fuse'), env.PROOF_ARM_TX),
    kill: pick(lastIx((t) => String(t.ix || '').startsWith('trigger_')), env.PROOF_KILL_TX),
    flashOpen: pick(lastReceipt((r) => r.reason === 'INITIAL_OPEN'), env.PROOF_FLASH_OPEN_TX),
    flashResize: pick(lastReceipt((r) => r.reason === 'PROBABILITY_STEP_UP' || r.reason === 'PROBABILITY_STEP_DOWN'), env.PROOF_FLASH_RESIZE_TX),
    flashClose: pick(lastReceipt((r) => r.reason === 'KILL_PROBABILITY' || r.reason === 'EMERGENCY_KILL'), env.PROOF_FLASH_CLOSE_TX)
  };
}

export class Runtime {
  constructor(env = process.env) {
    this.env = env;
    this.store = new FileStore(env.DATA_DIR || './.data');
  }

  async init() {
    await this.store.init();
    this.receipts = await this.store.read('receipts', []);
    this.eventSource = this.makeEventSource();
    this.market = await this.eventSource.init();
    this.basePolicy = JSON.parse(await fs.readFile(this.env.POLICY_FILE || './policy.example.json', 'utf8'));
    this.perp = await makePerpAdapter(this.env);
    this.chain = await this.store.read('chain', null);
    this.chainHooks = await this.makeChainHooks();

    let fuse = await this.store.read('fuse');
    // Each local fuse is bound to one onchain account and one market; start a new mandate if either changed.
    if (!fuse || fuse.chainFuse !== this.chain?.fusePda || fuse.policy.eventMarket !== this.market.id) {
      const position = await this.perp.getPosition();
      const venueUsd = Number(position.exposureUsd || 0);
      const localUsd = Number(fuse?.filledExposureUsd || 0);
      const localOpen = fuse && !TERMINAL.includes(fuse.status) && Math.abs(localUsd) >= 0.01;
      if (localOpen || Math.abs(venueUsd) >= 0.01) {
        const who = fuse ? `fuse ${fuse.id} on ${fuse.policy.eventMarket}` : 'no local fuse (DATA_DIR is empty)';
        throw new Error(`${who} still has venue exposure ${venueUsd} USD; restore the data disk or close the Flash position before starting a new mandate`);
      }
      fuse = this.newFuse();
      await this.provisionChainFuse(fuse);
      this.receipts = [];
      await this.store.write('receipts', this.receipts);
    }
    this.bindEngine(fuse);
    await this.persist(fuse);
    return this;
  }

  makeEventSource() {
    const kind = (this.env.EVENT_SOURCE || 'polymarket').toLowerCase();
    if (kind === 'polymarket') {
      const src = new PolymarketEventSource({ market: this.env.POLYMARKET_MARKET || DEFAULT_POLYMARKET_MARKET, outcome: this.env.POLYMARKET_OUTCOME || 'Yes', gammaUrl: this.env.POLYMARKET_GAMMA_URL, clobUrl: this.env.POLYMARKET_CLOB_URL });
      const init = src.init.bind(src);
      src.init = async () => { const i = await init(); return { kind, id: i.slug, question: i.question, outcome: i.outcome, url: i.url, endDateMs: i.endDateMs }; };
      return src;
    }
    if (kind === 'dflow') {
      const src = new DFlowEventSource({ baseUrl: this.env.DFLOW_BASE_URL, apiKey: this.env.DFLOW_API_KEY, marketMint: this.env.DFLOW_MARKET_MINT });
      src.init = async () => ({ kind, id: this.env.DFLOW_MARKET_MINT, question: this.env.DFLOW_MARKET_MINT, outcome: 'YES', url: null, endDateMs: null });
      return src;
    }
    throw new Error(`unsupported EVENT_SOURCE=${kind}`);
  }

  newFuse() {
    const policy = structuredClone(this.basePolicy);
    policy.eventMarket = this.market.id;
    policy.outcomeId = String(this.market.outcome).toUpperCase();
    policy.venue = (this.env.PERP_ADAPTER || 'flash').toUpperCase();
    policy.marketId = this.env.PERP_SYMBOL || 'SOL-PERP';
    // A mandate never outlives the market it is priced on.
    if (this.market.endDateMs) {
      const marketEnd = Math.floor(this.market.endDateMs / 1000);
      if (marketEnd <= Math.floor(Date.now() / 1000) + 60) throw new Error(`market ${this.market.id} end date has passed; choose an active market`);
      policy.expiryTs = Math.min(policy.expiryTs, marketEnd);
    }
    validatePolicy(policy);
    const { owner, oracle, exec } = this.chainClients;
    return initialFuse({
      id: `fuse_${crypto.randomBytes(5).toString('hex')}`,
      owner: owner.wallet.publicKey.toBase58(),
      agent: owner.wallet.publicKey.toBase58(),
      executionAuthority: exec.wallet.publicKey.toBase58(),
      oracleAuthority: oracle.wallet.publicKey.toBase58(),
      policy,
      policyHash: policyHash(policy)
    });
  }

  activeFusePda() { return this.chain?.fusePda || null; }

  async makeChainHooks() {
    const mk = async (key, name) => {
      if (!key) throw new Error(`${name} is required`);
      const c = new AnchorFuseClient({ ...this.env, FUSE_PDA: this.activeFusePda() || '', FUSE_AUTHORITY_PRIVATE_KEY_JSON: key });
      await c.init(); return c;
    };
    const owner = await mk(this.env.FUSE_OWNER_PRIVATE_KEY_JSON, 'FUSE_OWNER_PRIVATE_KEY_JSON');
    const oracle = await mk(this.env.FUSE_ORACLE_PRIVATE_KEY_JSON, 'FUSE_ORACLE_PRIVATE_KEY_JSON');
    const exec = await mk(this.env.FUSE_EXECUTION_PRIVATE_KEY_JSON, 'FUSE_EXECUTION_PRIVATE_KEY_JSON');
    this.chainClients = { owner, oracle, exec };
    return {
      arm: () => owner.arm(), settle: () => owner.settle(),
      acceptObservation: (x) => oracle.acceptObservation(x),
      setTarget: (x) => exec.setTarget(x), killProbability: () => exec.killProbability(), killAuthorized: (r) => exec.killAuthorized(r),
      recordFill: (x) => exec.recordFill(x)
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

  // Creates a fresh onchain Fuse account committed to this fuse's policy and points all authorities at it.
  async provisionChainFuse(fuse) {
    const { owner, oracle, exec } = this.chainClients;
    const { fuse: pda, signature } = await owner.initFuse({
      fuseId: BigInt(Date.now()),
      policy: fuse.policy,
      agent: fuse.agent,
      executionAuthority: exec.wallet.publicKey.toBase58(),
      oracleAuthority: oracle.wallet.publicKey.toBase58()
    });
    const pk = new owner.web3.PublicKey(pda);
    for (const c of [owner, oracle, exec]) c.fusePda = pk;
    fuse.chainFuse = pda;
    fuse.chainTxs = [{ ix: 'init_fuse', signature, at: Date.now() }];
    this.chain = { fusePda: pda, createTx: signature, createdAt: Date.now() };
    await this.store.write('chain', this.chain);
  }

  // Starts the next mandate once the current one is finished (killed or settled, no open exposure).
  async newMandate() {
    const current = this.engine.fuse;
    if (current.status === 'PROPOSED') return this.getState();
    if (!TERMINAL.includes(current.status)) throw new Error(`current fuse is ${current.status}; kill or settle it first`);
    const position = await this.perp.getPosition();
    if (Math.abs(Number(position.exposureUsd || 0)) >= 0.01) throw new Error('venue position is still open; wait for the close to reconcile');
    const cooldownMs = Number(this.env.FUSE_RESET_COOLDOWN_SEC ?? 10) * 1000;
    if (Date.now() - (this.chain?.createdAt || 0) < cooldownMs) throw new Error(`cooldown: wait ${Math.ceil((cooldownMs - (Date.now() - this.chain.createdAt)) / 1000)}s`);
    // Provision first so a failed onchain create leaves the current fuse untouched.
    const fuse = this.newFuse();
    await this.provisionChainFuse(fuse);
    this.receipts = [];
    await this.store.write('receipts', this.receipts);
    this.bindEngine(fuse);
    await this.persist(fuse);
    return this.getState();
  }

  async getState() {
    const position = await this.perp.getPosition();
    return { integrity: this.integrity(), market: this.market, fuse: this.engine.snapshot(), position, receipts: this.receipts };
  }

  integrity() {
    return {
      onchain: true,
      network: this.env.SOLANA_CLUSTER || 'devnet',
      perpAdapter: (this.env.PERP_ADAPTER || 'flash').toLowerCase(),
      eventSource: this.market?.kind || null,
      programId: this.env.FUSE_PROGRAM_ID || null,
      fusePda: this.activeFusePda(),
      buildTag: this.env.BUILD_TAG || 'dev',
      buildSha: this.env.BUILD_SHA || 'DEV_UNSET',
      publicUrl: this.env.PUBLIC_URL || null
    };
  }

  proof() {
    const cluster = this.env.SOLANA_CLUSTER || 'devnet';
    const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${encodeURIComponent(cluster)}`;
    const base = this.env.SOLSCAN_BASE_URL || 'https://solscan.io';
    const link = (kind, value) => value ? `${base}/${kind}/${value}${suffix}` : null;
    const txs = proofTransactions({ env: this.env, chain: this.chain, fuse: this.engine?.fuse, receipts: this.receipts });
    const tx = (value) => ({ value: value || null, url: link('tx', value) });
    return {
      integrity: this.integrity(),
      program: { value: this.env.FUSE_PROGRAM_ID || null, url: link('account', this.env.FUSE_PROGRAM_ID) },
      fuseAccount: { value: this.activeFusePda(), url: link('account', this.activeFusePda()) },
      transactions: {
        create: tx(txs.create),
        arm: tx(txs.arm),
        kill: tx(txs.kill),
        flashOpen: tx(txs.flashOpen),
        flashResize: tx(txs.flashResize),
        flashClose: tx(txs.flashClose)
      }
    };
  }

  async tick() { return this.engine.tick(); }
  async arm() { return this.engine.arm(); }
  async kill() { return this.engine.kill(); }
  async settle() { return this.engine.settle(); }
  async verify() { return verifyFuse({ fuse: this.engine.snapshot(), receipts: this.receipts }); }
}

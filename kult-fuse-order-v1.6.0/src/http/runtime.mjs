import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { FileStore } from '../adapters/store/file-store.mjs';
import { DFlowEventSource } from '../adapters/event/dflow-event.mjs';
import { PolymarketEventSource } from '../adapters/event/polymarket-event.mjs';
import { makePerpAdapter } from '../adapters/perp/factory.mjs';
import { policyHash, validatePolicy } from '../core/policy.mjs';
import { initialFuse } from '../core/state.mjs';
import { FuseEngine } from '../worker/fuse-engine.mjs';
import { verifyExecution } from '../core/verifier.mjs';
import { makeProbabilityMark, explainSignal } from '../core/probability.mjs';
import { AnchorFuseClient } from '../adapters/store/anchor-fuse-client.mjs';
import { fuseFillEvidence } from '../adapters/store/fuse-evidence.mjs';
import { makeDecision, retainDecisions } from '../core/decision.mjs';

const TERMINAL = ['KILLED', 'SETTLED'];

// A Solana signature is 64 bytes, which is 86 to 88 base58 characters. Anything else
// (a venue order id, a placeholder) must never be published as an explorer link.
export const isSignature = (value) => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(value);

// Only the current mandate's chain transactions and actual venue receipts qualify.
export function proofTransactions({ chain = null, fuse = null, receipts = [] } = {}) {
  const txs = fuse?.chainTxs || [];
  const lastIx = (pred) => [...txs].reverse().find((t) => pred(t) && isSignature(t.signature))?.signature || null;
  const lastReceipt = (pred) => [...receipts].reverse().find((r) => pred(r) && isSignature(r.txSignature))?.txSignature || null;
  return {
    create: isSignature(chain?.createTx) ? chain.createTx : lastIx((t) => t.ix === 'init_fuse'),
    arm: lastIx((t) => t.ix === 'arm_fuse'),
    target: lastIx((t) => t.ix === 'set_target'),
    kill: lastIx((t) => String(t.ix || '').startsWith('trigger_')),
    venueOpen: lastReceipt((r) => r.reason === 'INITIAL_OPEN'),
    venueResize: lastReceipt((r) => r.reason === 'PROBABILITY_STEP_UP' || r.reason === 'PROBABILITY_STEP_DOWN'),
    venueClose: lastReceipt((r) => r.reason === 'KILL_PROBABILITY' || r.reason === 'EMERGENCY_KILL' || r.reason === 'LOSS_STOP' || r.reason === 'EXPIRY_CLOSE')
  };
}

export class Runtime {
  constructor(env = process.env) {
    this.env = env;
    this.store = new FileStore(env.DATA_DIR || './.data');
    this.quote = null;
    this.quoteError = null;
    this.mutationQueue = Promise.resolve();
  }

  // A manual kill, worker tick and new mandate must never mutate the same
  // nonce or venue position concurrently. Recover the queue after rejection.
  runExclusive(operation) {
    const next = (this.mutationQueue || Promise.resolve()).then(operation);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  async init() {
    if ((this.env.PERP_ADAPTER || 'drift').toLowerCase() === 'drift' && (this.env.DRIFT_ENV || 'devnet') !== (this.env.SOLANA_CLUSTER || 'devnet')) {
      throw new Error('live Fuse and Drift must be on the same Solana cluster; the scripted proof runner is separate');
    }
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
        throw new Error(`${who} still has venue exposure ${venueUsd} USD; restore the data disk or close the venue position before starting a new mandate`);
      }
      fuse = this.newFuse();
      await this.provisionChainFuse(fuse);
      this.receipts = [];
      await this.store.write('receipts', this.receipts);
    }
    this.bindEngine(fuse);
    this.decisions = (await this.store.read('decisions', [])).filter((item) => item.fuseId === fuse.id).slice(-60);
    await this.persist(fuse);
    return this;
  }

  makeEventSource() {
    const kind = (this.env.EVENT_SOURCE || 'polymarket').toLowerCase();
    if (kind === 'polymarket') {
      if (!this.env.POLYMARKET_MARKET) throw new Error('POLYMARKET_MARKET must be selected explicitly for the live mandate');
      const src = new PolymarketEventSource({ market: this.env.POLYMARKET_MARKET, outcome: this.env.POLYMARKET_OUTCOME || 'Yes', gammaUrl: this.env.POLYMARKET_GAMMA_URL, clobUrl: this.env.POLYMARKET_CLOB_URL });
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
    policy.venue = (this.env.PERP_ADAPTER || 'drift').toUpperCase();
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
  async createMandate() {
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
    if (this.decisionWrite) await this.decisionWrite;
    this.decisions = [];
    await this.store.write('decisions', this.decisions);
    this.bindEngine(fuse);
    await this.persist(fuse);
    return this.getState();
  }

  // A replay is offered as verified only when the verifier passed it against the chain.
  async verifiedRunPayload() {
    const live = this.receipts || [];
    const txs = proofTransactions({ chain: this.chain, fuse: this.engine?.fuse, receipts: live });
    if (live.some((r) => r.txSignature)) {
      const v = await this.verify();
      if (v.status === 'VERIFIED') return { source: 'live', residualUsd: Number(this.engine.fuse.filledExposureUsd || 0), transactions: txs, receipts: live };
    }
    return null;
  }

  startQuoteWatch() {
    const pull = async () => {
      try {
        const raw = await this.eventSource.read();
        this.quote = {
          question: this.market?.question || null,
          outcome: this.market?.outcome || null,
          url: this.market?.url || null,
          raw,
          source: raw.source,
          at: new Date().toISOString()
        };
        this.quoteError = null;
      } catch (error) {
        this.quoteError = error.message;
      }
    };
    pull();
    setInterval(pull, 8000).unref();
  }

  // Age is computed at read time, so a quote that stopped updating visibly goes stale.
  quoteView() {
    if (!this.quote) return null;
    const { raw, ...rest } = this.quote;
    const policy = this.engine.fuse.policy;
    const mark = makeProbabilityMark(raw, policy);
    return {
      ...rest, bid: mark.bid, ask: mark.ask, probability: mark.probability, spreadBps: mark.spreadBps,
      ageSec: mark.ageSec, depthUsd: mark.depthUsd, quality: mark.quality, qualityReason: mark.qualityReason,
      explain: explainSignal(mark, policy, this.engine.fuse.desiredExposureUsd)
    };
  }

  async getState() {
    const position = await this.perp.getPosition();
    return { integrity: this.integrity(), market: this.market, quote: this.quoteView(), fuse: this.engine.snapshot(), position, receipts: this.receipts, decisions: this.decisions || [] };
  }

  integrity() {
    return {
      onchain: true,
      network: this.env.SOLANA_CLUSTER || 'devnet',
      perpAdapter: (this.env.PERP_ADAPTER || 'drift').toLowerCase(),
      eventSource: this.market?.kind || null,
      programId: this.env.FUSE_PROGRAM_ID || null,
      fusePda: this.activeFusePda(),
      buildTag: this.env.BUILD_TAG || 'dev',
      buildSha: this.env.BUILD_SHA || 'DEV_UNSET',
      publicUrl: this.env.PUBLIC_URL || null,
      venueAuthority: this.venueAuthority()
    };
  }

  // This build has no program-signed venue delegation; never infer it from a config flag.
  venueAuthority() {
    return {
      bound: false,
      venue: (this.env.PERP_ADAPTER || 'drift').toUpperCase(),
      limitation: 'The venue key can trade outside Fuse. The program verifies worker-submitted targets; only a confirmed venue close flattens a position. Owner-controlled revocation or program-signed venue delegation is not implemented in this build.'
    };
  }

  chainReader() {
    const exec = this.chainClients.exec;
    const fuseCluster = this.env.SOLANA_CLUSTER || 'devnet';
    // A venue on another cluster (e.g. Drift mainnet) is checked through that cluster's RPC.
    const venueConn = this.perp?.connection;
    return {
      txStatus: async (sig, cluster) => {
        const conn = cluster && cluster !== fuseCluster && venueConn ? venueConn : exec.provider.connection;
        const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
        const st = value?.[0];
        return { confirmed: Boolean(st && ['confirmed', 'finalized'].includes(st.confirmationStatus)), err: st?.err ?? null };
      },
      venueEvidence: async (sig, receipt) => {
        if (!this.perp?.verifyFillTransaction) return { ok: false, why: 'this venue has no independent fill decoder' };
        if (receipt.venueRef !== this.perp.userPk?.toBase58()) return { ok: false, why: 'receipt references a different venue account' };
        if (receipt.marketId !== this.perp.opts?.symbol) return { ok: false, why: 'receipt references a different perp market' };
        return this.perp.verifyFillTransaction(sig, receipt);
      },
      fillEvidence: (sig, receipt) => fuseFillEvidence({ connection: exec.provider.connection,
        program: exec.program, fusePda: this.activeFusePda(), signature: sig, receipt }),
      fuseState: async () => {
        const account = await exec.fetch();
        return { policyHash: Buffer.from(account.curveHash).toString('hex') };
      },
      receiptHead: async () => Buffer.from((await exec.fetch()).lastReceiptHash).toString('hex')
    };
  }

  async proof() {
    const cluster = this.env.SOLANA_CLUSTER || 'devnet';
    const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${encodeURIComponent(cluster)}`;
    const base = this.env.SOLSCAN_BASE_URL || 'https://solscan.io';
    const link = (kind, value, venueCluster) => value ? `${base}/${kind}/${value}${venueCluster === 'mainnet-beta' ? '' : venueCluster ? `?cluster=${encodeURIComponent(venueCluster)}` : suffix}` : null;
    const txs = proofTransactions({ chain: this.chain, fuse: this.engine?.fuse, receipts: this.receipts });
    const tx = (value, venue = false) => {
      const clusterOverride = venue ? this.receipts.find((r) => r.txSignature === value)?.venueCluster : null;
      return { value: value || null, url: link('tx', value, clusterOverride) };
    };
    return {
      integrity: this.integrity(),
      program: { value: this.env.FUSE_PROGRAM_ID || null, url: link('account', this.env.FUSE_PROGRAM_ID) },
      fuseAccount: { value: this.activeFusePda(), url: link('account', this.activeFusePda()) },
      transactions: {
        create: tx(txs.create),
        arm: tx(txs.arm),
        kill: tx(txs.kill),
        venueOpen: tx(txs.venueOpen, true),
        venueResize: tx(txs.venueResize, true),
        venueClose: tx(txs.venueClose, true),
        target: tx(txs.target)
      },
      verifiedRun: await this.verifiedRunPayload()
    };
  }

  async recordDecision(action, operation) {
    let result, error;
    try { result = await operation(); }
    catch (e) { error = e; }
    let position = result?.position || null;
    if (!position) {
      try { position = await this.perp.getPosition(); } catch { /* unavailable is not zero exposure */ }
    }
    const decision = makeDecision({ action, fuse: this.engine.snapshot(), result, error, position });
    this.decisions = retainDecisions(this.decisions || [], decision);
    // Auto worker and operator actions can finish together. Serialize writes
    // because FileStore's atomic temp path is shared by the process.
    this.decisionWrite = (this.decisionWrite || Promise.resolve()).catch(() => {})
      .then(() => this.store.write('decisions', this.decisions));
    await this.decisionWrite;
    if (error) throw error;
    return result;
  }
  async tick() { return this.runExclusive(() => this.recordDecision('tick', () => this.engine.tick())); }
  async arm() { return this.runExclusive(() => this.recordDecision('arm', () => this.engine.arm())); }
  async kill() { return this.runExclusive(() => this.recordDecision('kill', () => this.engine.kill())); }
  async settle() { return this.runExclusive(() => this.engine.settle()); }
  async newMandate() { return this.runExclusive(() => this.createMandate()); }
  async verify() { return verifyExecution({ fuse: this.engine.snapshot(), receipts: this.receipts, chain: this.chainReader() }); }
}

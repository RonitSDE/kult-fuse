/**
 * Velocity adapter: one SOL-PERP long on Velocity (Drift v2's successor, program
 * vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P on devnet and mainnet-beta), reconciled to an
 * absolute USD target.
 *
 * Every order is a price-bounded immediate-or-cancel taker order, so nothing rests on the book
 * after a kill. A confirmed transaction is not a fill: the adapter re-reads the user account and
 * raises VENUE_NO_FILL when the base position did not move.
 *
 * Collateral is the venue's quote asset: dUSDT on devnet (mintable from the SDK's TokenFaucet),
 * USDT on mainnet-beta. Unrealized P&L comes from the position's quote entry amount, which already
 * has fees taken out, so the loss stop sees P&L net of fees.
 */
import { createRequire } from 'node:module';
import { velocityVenueEvidence } from './velocity-evidence.mjs';
import { assertCollateralizedIncrease } from '../../core/venue-risk.mjs';

const require = createRequire(import.meta.url);
export const VELOCITY_PROGRAM = 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';

export class VelocityPerpAdapter {
  constructor(opts = {}) {
    this.opts = {
      env: 'devnet',
      marketIndex: 0,
      symbol: 'SOL-PERP',
      subAccountId: 0,
      maxSlippageBps: 50,
      minOrderUsd: 1,
      fillTimeoutMs: 20000,
      ...opts
    };
    this.ready = false;
    this.venue = 'VELOCITY';
  }

  get cluster() { return this.opts.env; }

  async init() {
    if (!Number.isFinite(this.opts.maxSlippageBps) || this.opts.maxSlippageBps <= 0 || this.opts.maxSlippageBps > 1000) {
      throw new Error('VELOCITY maxSlippageBps must be within (0, 1000]');
    }
    if (!['devnet', 'mainnet-beta'].includes(this.opts.env)) throw new Error(`VELOCITY_ENV must be devnet or mainnet-beta, got ${this.opts.env}`);
    if (this.opts.env === 'mainnet-beta' && !this.opts.allowMainnetOrders) {
      throw new Error('mainnet venue orders disabled; this hackathon build is devnet-only unless separately approved');
    }
    const sdk = require('@velocity-exchange/sdk');
    const web3 = require('@solana/web3.js');
    const secret = JSON.parse(this.opts.privateKeyJson || '[]');
    if (!Array.isArray(secret) || secret.length < 32) throw new Error('VELOCITY_PRIVATE_KEY_JSON missing/invalid');
    if (!this.opts.rpcUrl) throw new Error('VELOCITY_RPC_URL is required');
    const kp = web3.Keypair.fromSecretKey(Uint8Array.from(secret));
    const connection = new web3.Connection(this.opts.rpcUrl, 'confirmed');
    const config = sdk.initialize({ env: this.opts.env });
    const mainnet = this.opts.env === 'mainnet-beta';
    const perpCfg = (mainnet ? sdk.MainnetPerpMarkets : sdk.DevnetPerpMarkets).find((m) => m.marketIndex === this.opts.marketIndex);
    const spotCfg = (mainnet ? sdk.MainnetSpotMarkets : sdk.DevnetSpotMarkets).find((m) => m.marketIndex === 0);
    if (!perpCfg || !spotCfg) throw new Error(`Velocity ${this.opts.env} has no perp market ${this.opts.marketIndex} or quote spot market`);
    if (perpCfg.symbol !== this.opts.symbol) throw new Error(`Velocity perp market ${this.opts.marketIndex} is ${perpCfg.symbol}, expected ${this.opts.symbol}`);
    // Subscribe to one perp and the quote market only; loading every market trips RPC rate limits.
    const client = new sdk.VelocityClient({
      connection,
      wallet: new sdk.Wallet(kp),
      env: this.opts.env,
      opts: { commitment: 'confirmed', preflightCommitment: 'confirmed' },
      perpMarketIndexes: [this.opts.marketIndex],
      spotMarketIndexes: [0],
      subAccountIds: [this.opts.subAccountId],
      activeSubAccountId: this.opts.subAccountId,
      oracleInfos: [{ publicKey: perpCfg.oracle, source: perpCfg.oracleSource }, { publicKey: spotCfg.oracle, source: spotCfg.oracleSource }],
      accountSubscription: { type: 'polling', accountLoader: new sdk.BulkAccountLoader(connection, 'confirmed', 1000) }
    });
    if ((await client.subscribe()) === false) throw new Error('failed to subscribe to Velocity accounts');
    Object.assign(this, { sdk, web3, kp, connection, config, client });
    this.programId = new web3.PublicKey(config.VELOCITY_PROGRAM_ID);
    if (this.programId.toBase58() !== VELOCITY_PROGRAM) throw new Error(`unexpected Velocity program ${this.programId.toBase58()}`);
    this.userPk = await sdk.getUserAccountPublicKey(this.programId, kp.publicKey, this.opts.subAccountId);
    if (await connection.getAccountInfo(this.userPk)) await this._attachUser();
    const market = client.getPerpMarketAccount(this.opts.marketIndex);
    if (!market) throw new Error(`Velocity perp market ${this.opts.marketIndex} not found on ${this.opts.env}`);
    // Velocity moved orderStepSize onto the market and minOrderSize into marketStats.
    this.stepBase = this._num(market.orderStepSize ?? market.amm?.orderStepSize, sdk.BASE_PRECISION);
    this.minBase = this._num(market.marketStats?.minOrderSize ?? market.amm?.minOrderSize ?? market.orderStepSize, sdk.BASE_PRECISION);
    if (!(this.stepBase > 0)) throw new Error('Velocity market reports no order step size');
    this.ready = true;
    return this;
  }

  async ensureReady() { if (!this.ready) await this.init(); }
  _num(bn, precision) { return this.sdk.convertToNumber(bn, precision); }

  async _attachUser() {
    await this.client.addUser(this.opts.subAccountId);
    await this.client.switchActiveUser(this.opts.subAccountId);
    this.user = this.client.getUser(this.opts.subAccountId);
    this.hasUser = true;
  }

  markPrice() {
    return this._num(this.client.getOracleDataForPerpMarket(this.opts.marketIndex).price, this.sdk.PRICE_PRECISION);
  }

  quoteMint() { return new this.web3.PublicKey(this.config.QUOTE_MINT_ADDRESS); }

  async walletQuote() {
    const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
    const ata = getAssociatedTokenAddressSync(this.quoteMint(), this.kp.publicKey);
    const bal = await this.connection.getTokenAccountBalance(ata).catch(() => null);
    return { ata, amount: Number(bal?.value?.uiAmount || 0) };
  }

  async collateralUsd() {
    if (!this.hasUser) return 0;
    await this.user.fetchAccounts();
    return this._num(this.user.getTotalCollateral(), this.sdk.QUOTE_PRECISION);
  }

  async assertRiskIncrease({ desiredExposureUsd, policy }) {
    await this.ensureReady();
    // Fresh margin/collateral check immediately before submitting any size increase.
    // Operational only: does not close the bypass through a stolen trading key.
    const collateralUsd = await this.collateralUsd();
    return assertCollateralizedIncrease({ desiredExposureUsd, collateralUsd, maxLeverageBps: policy.maxLeverageBps });
  }

  /** Devnet only: mint test dUSDT to the venue wallet from the SDK's TokenFaucet program. */
  async mintDevnetQuote(amountUsd, faucetProgramId) {
    if (this.opts.env !== 'devnet') throw new Error('the dUSDT faucet exists on devnet only');
    if (!faucetProgramId) throw new Error('VELOCITY_FAUCET_PROGRAM_ID is required to mint devnet dUSDT');
    const faucet = new this.sdk.TokenFaucet(this.connection, new this.sdk.Wallet(this.kp), new this.web3.PublicKey(faucetProgramId), this.quoteMint());
    const [, signature] = await faucet.createAssociatedTokenAccountAndMintTo(this.kp.publicKey, new this.sdk.BN(Math.floor(amountUsd * 1e6)));
    this.setupTxs = [...(this.setupTxs || []), { ix: 'velocity_faucet_mint', signature }];
    return signature;
  }

  // Setup only: create the Velocity account if needed and deposit wallet collateral up to `targetUsd`.
  async ensureCollateral(targetUsd) {
    await this.ensureReady();
    if (!this.hasUser) {
      const [sig] = await this.client.initializeUserAccount(this.opts.subAccountId, 'kult-fuse');
      await this._attachUser();
      this.setupTxs = [...(this.setupTxs || []), { ix: 'velocity_initialize_user', signature: sig }];
    }
    const have = await this.collateralUsd();
    if (have >= targetUsd) return { collateralUsd: have, deposited: 0 };
    const { ata, amount: wallet } = await this.walletQuote();
    const amount = Math.min(wallet, targetUsd - have);
    if (amount <= 0) throw new Error(`wallet ${this.kp.publicKey.toBase58()} holds no ${this.opts.env === 'devnet' ? 'dUSDT' : 'USDT'} to deposit (need ${(targetUsd - have).toFixed(2)})`);
    const sig = await this.client.deposit(new this.sdk.BN(Math.floor(amount * 1e6)), 0, ata, this.opts.subAccountId);
    this.setupTxs = [...(this.setupTxs || []), { ix: 'velocity_deposit', signature: sig }];
    return { collateralUsd: await this.collateralUsd(), deposited: amount, signature: sig };
  }

  async getPosition() {
    await this.ensureReady();
    const markPrice = this.markPrice();
    const base = { venue: this.venue, cluster: this.cluster, symbol: this.opts.symbol, side: 'long', markPrice, positionRef: this.userPk.toBase58() };
    if (!this.hasUser) return { ...base, exposureUsd: 0, unrealizedPnlUsd: 0, baseAmount: 0 };
    await this.user.fetchAccounts();
    const pos = this.user.getPerpPosition(this.opts.marketIndex);
    const baseAmount = pos ? this._num(pos.baseAssetAmount, this.sdk.BASE_PRECISION) : 0;
    if (baseAmount < 0) throw new Error('Velocity account holds a short SOL-PERP position; Fuse manages longs only');
    const pnl = baseAmount === 0 ? 0 : this._num(this.user.getUnrealizedPNL(true, this.opts.marketIndex), this.sdk.QUOTE_PRECISION);
    return { ...base, exposureUsd: baseAmount * markPrice, unrealizedPnlUsd: pnl, baseAmount };
  }

  _roundBase(base) { return Math.floor(base / this.stepBase + 1e-9) * this.stepBase; }

  _orderParams(direction, baseAmount, reduceOnly, referencePrice) {
    const { sdk, client } = this;
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) throw new Error('stale/invalid perp oracle price');
    const limitPrice = referencePrice * (1 + (direction === 'long' ? 1 : -1) * this.opts.maxSlippageBps / 10_000);
    return sdk.getLimitOrderParams({
      marketIndex: this.opts.marketIndex,
      marketType: sdk.MarketType.PERP,
      direction: direction === 'long' ? sdk.PositionDirection.LONG : sdk.PositionDirection.SHORT,
      baseAssetAmount: client.convertToPerpPrecision(baseAmount),
      price: new sdk.BN(Math.floor(limitPrice * 1e6)),
      reduceOnly,
      // Velocity carries IOC as an order-params bit flag rather than Drift's boolean field.
      bitFlags: sdk.OrderParamsBitFlag.ImmediateOrCancel
    });
  }

  async _boundedOrder(direction, baseAmount, reduceOnly, referencePrice) {
    const params = this._orderParams(direction, baseAmount, reduceOnly, referencePrice);
    // switchActiveUser() already scoped this client to the dedicated Fuse subaccount.
    return this.client.placeAndTakePerpOrder(params);
  }

  async executeTarget(targetUsd, { reduceOnly = false } = {}) {
    await this.ensureReady();
    if (!this.hasUser) throw new Error('Velocity account not initialized; run `npm run venue:setup` to deposit collateral');
    const target = Number(targetUsd);
    if (!Number.isFinite(target) || target < 0) throw new Error('Velocity Fuse adapter supports non-negative SOL targets only');
    const before = await this.getPosition();
    const desired = reduceOnly ? Math.min(target, before.exposureUsd) : target;
    const delta = desired - before.exposureUsd;
    const noop = { ok: true, txSignature: null, venueRef: before.positionRef, before, after: before, deltaUsd: 0 };
    if (Math.abs(delta) < Number(this.opts.minOrderUsd) && desired !== 0) return noop;

    let txSignature;
    if (desired === 0) {
      if (before.baseAmount === 0) return noop;
      txSignature = await this._boundedOrder('short', before.baseAmount, true, before.markPrice);
    } else {
      const baseDelta = this._roundBase(Math.abs(delta) / before.markPrice);
      if (baseDelta < this.minBase) return noop;
      txSignature = await this._boundedOrder(delta > 0 ? 'long' : 'short', baseDelta, delta < 0, before.markPrice);
    }

    const after = await this._settle(before);
    if (Math.abs(after.baseAmount - before.baseAmount) < this.stepBase / 2) {
      const error = new Error(`venue order ${txSignature} confirmed but no SOL-PERP fill; exposure unchanged`);
      error.code = 'VENUE_NO_FILL';
      error.venueSignature = txSignature;
      throw error;
    }
    return { ok: true, txSignature, venueRef: after.positionRef, before, after, deltaUsd: after.exposureUsd - before.exposureUsd, cluster: this.cluster };
  }

  // Waits until the account shows the fill; the receipt records what the account says, not what was asked.
  async _settle(before) {
    const deadline = Date.now() + Number(this.opts.fillTimeoutMs);
    let after = before;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      after = await this.getPosition();
      if (after.baseAmount !== before.baseAmount) break;
    }
    return after;
  }

  async close() { return this.executeTarget(0, { reduceOnly: true }); }

  async verifyFillTransaction(signature, receipt) {
    await this.ensureReady();
    return velocityVenueEvidence({
      connection: this.connection,
      parse: (logs) => this.sdk.parseLogs(this.client.program, logs, this.programId.toBase58()),
      programId: this.programId.toBase58(),
      user: this.userPk.toBase58(),
      marketIndex: this.opts.marketIndex,
      signature,
      receipt,
      toleranceBase: Math.max(this.stepBase, 1e-8)
    });
  }
}

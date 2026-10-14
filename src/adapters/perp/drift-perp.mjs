/**
 * Drift Protocol adapter: one SOL-PERP long, reconciled to an absolute USD target.
 *
 * Every order is a place-and-take market order, so the fill lands in the same
 * transaction whose signature goes into the receipt. getPosition() is read before
 * and after every mutation; the receipt never trusts the order, only the account.
 *
 * Drift's unrealized P&L is computed from the position's quote entry amount, which
 * already has trading fees taken out, so the loss stop sees P&L net of fees.
 */
export class DriftPerpAdapter {
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
  }

  get cluster() { return this.opts.env; }

  async init() {
    const [d, web3] = await Promise.all([import('@drift-labs/sdk'), import('@solana/web3.js')]);
    const sdk = d.default?.DriftClient ? d.default : d;
    const secret = JSON.parse(this.opts.privateKeyJson || '[]');
    if (!Array.isArray(secret) || secret.length < 32) throw new Error('DRIFT_PRIVATE_KEY_JSON missing/invalid');
    if (!this.opts.rpcUrl) throw new Error('DRIFT_RPC_URL is required');
    const kp = web3.Keypair.fromSecretKey(Uint8Array.from(secret));
    const connection = new web3.Connection(this.opts.rpcUrl, 'confirmed');
    const config = sdk.initialize({ env: this.opts.env });
    // Subscribe to SOL-PERP and USDC only; loading every market trips RPC rate limits.
    const mainnet = this.opts.env === 'mainnet-beta';
    const perpCfg = (mainnet ? sdk.MainnetPerpMarkets : sdk.DevnetPerpMarkets).find((m) => m.marketIndex === this.opts.marketIndex);
    const spotCfg = (mainnet ? sdk.MainnetSpotMarkets : sdk.DevnetSpotMarkets).find((m) => m.marketIndex === 0);
    if (!perpCfg || !spotCfg) throw new Error(`Drift ${this.opts.env} config has no perp market ${this.opts.marketIndex} or USDC spot market`);
    const client = new sdk.DriftClient({
      connection,
      wallet: new sdk.Wallet(kp),
      env: this.opts.env,
      perpMarketIndexes: [this.opts.marketIndex],
      spotMarketIndexes: [0],
      oracleInfos: [{ publicKey: perpCfg.oracle, source: perpCfg.oracleSource }, { publicKey: spotCfg.oracle, source: spotCfg.oracleSource }],
      accountSubscription: { type: 'polling', accountLoader: new sdk.BulkAccountLoader(connection, 'confirmed', 1000) }
    });
    await client.subscribe();
    Object.assign(this, { sdk, web3, kp, connection, config, client });
    this.userPk = await sdk.getUserAccountPublicKey(new web3.PublicKey(config.DRIFT_PROGRAM_ID), kp.publicKey, this.opts.subAccountId);
    if (await connection.getAccountInfo(this.userPk)) await this._attachUser();
    const market = client.getPerpMarketAccount(this.opts.marketIndex);
    if (!market) throw new Error(`Drift perp market ${this.opts.marketIndex} not found on ${this.opts.env}`);
    this.stepBase = this._num(market.amm.orderStepSize, sdk.BASE_PRECISION);
    this.minBase = this._num(market.amm.minOrderSize, sdk.BASE_PRECISION);
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

  usdcMint() { return new this.web3.PublicKey(this.config.USDC_MINT_ADDRESS); }

  async walletUsdc() {
    const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
    const ata = getAssociatedTokenAddressSync(this.usdcMint(), this.kp.publicKey);
    const bal = await this.connection.getTokenAccountBalance(ata).catch(() => null);
    return { ata, usdc: Number(bal?.value?.uiAmount || 0) };
  }

  async collateralUsd() {
    if (!this.hasUser) return 0;
    await this.user.fetchAccounts();
    return this._num(this.user.getTotalCollateral(), this.sdk.QUOTE_PRECISION);
  }

  // Setup only: create the Drift account if needed and deposit wallet USDC up to `targetUsd` collateral.
  async ensureCollateral(targetUsd) {
    await this.ensureReady();
    if (!this.hasUser) {
      const [sig] = await this.client.initializeUserAccount(this.opts.subAccountId);
      await this._attachUser();
      this.setupTxs = [...(this.setupTxs || []), { ix: 'drift_initialize_user', signature: sig }];
    }
    const have = await this.collateralUsd();
    if (have >= targetUsd) return { collateralUsd: have, deposited: 0 };
    const { ata, usdc } = await this.walletUsdc();
    const amount = Math.min(usdc, targetUsd - have);
    if (amount <= 0) throw new Error(`wallet ${this.kp.publicKey.toBase58()} has no USDC to deposit (need ${(targetUsd - have).toFixed(2)})`);
    const sig = await this.client.deposit(new this.sdk.BN(Math.floor(amount * 1e6)), 0, ata, this.opts.subAccountId);
    this.setupTxs = [...(this.setupTxs || []), { ix: 'drift_deposit', signature: sig }];
    return { collateralUsd: await this.collateralUsd(), deposited: amount, signature: sig };
  }

  async getPosition() {
    await this.ensureReady();
    const markPrice = this.markPrice();
    const base = { venue: 'DRIFT', cluster: this.cluster, symbol: this.opts.symbol, side: 'long', markPrice, positionRef: this.userPk.toBase58() };
    if (!this.hasUser) return { ...base, exposureUsd: 0, unrealizedPnlUsd: 0, baseAmount: 0 };
    await this.user.fetchAccounts();
    const pos = this.user.getPerpPosition(this.opts.marketIndex);
    const baseAmount = pos ? this._num(pos.baseAssetAmount, this.sdk.BASE_PRECISION) : 0;
    if (baseAmount < 0) throw new Error('Drift account holds a short SOL-PERP position; Fuse v1 manages longs only');
    const pnl = baseAmount === 0 ? 0 : this._num(this.user.getUnrealizedPNL(true, this.opts.marketIndex), this.sdk.QUOTE_PRECISION);
    return { ...base, exposureUsd: baseAmount * markPrice, unrealizedPnlUsd: pnl, baseAmount };
  }

  _roundBase(base) { return Math.floor(base / this.stepBase + 1e-9) * this.stepBase; }

  async _marketOrder(direction, baseAmount, reduceOnly) {
    const { sdk, client } = this;
    const params = sdk.getMarketOrderParams({
      marketIndex: this.opts.marketIndex,
      direction: direction === 'long' ? sdk.PositionDirection.LONG : sdk.PositionDirection.SHORT,
      baseAssetAmount: client.convertToPerpPrecision(baseAmount),
      reduceOnly
    });
    return client.placeAndTakePerpOrder(params, undefined, undefined, undefined, undefined, undefined, this.opts.subAccountId);
  }

  async executeTarget(targetUsd, { reduceOnly = false } = {}) {
    await this.ensureReady();
    if (!this.hasUser) throw new Error('Drift account not initialized; run the proof setup to deposit collateral');
    const target = Number(targetUsd);
    if (!Number.isFinite(target) || target < 0) throw new Error('Drift Fuse adapter supports non-negative SOL targets only');
    const before = await this.getPosition();
    let desired = reduceOnly ? Math.min(target, before.exposureUsd) : target;
    const delta = desired - before.exposureUsd;
    if (Math.abs(delta) < Number(this.opts.minOrderUsd) && desired !== 0) {
      return { ok: true, txSignature: null, venueRef: before.positionRef, before, after: before, deltaUsd: 0 };
    }

    let txSignature;
    if (desired === 0) {
      if (before.baseAmount === 0) return { ok: true, txSignature: null, venueRef: before.positionRef, before, after: before, deltaUsd: 0 };
      txSignature = await this._marketOrder('short', before.baseAmount, true);
    } else {
      const baseDelta = this._roundBase(Math.abs(delta) / before.markPrice);
      if (baseDelta < this.minBase) return { ok: true, txSignature: null, venueRef: before.positionRef, before, after: before, deltaUsd: 0 };
      txSignature = await this._marketOrder(delta > 0 ? 'long' : 'short', baseDelta, delta < 0);
    }

    const after = await this._settle(before);
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
}

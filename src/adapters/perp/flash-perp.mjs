/**
 * Flash Trade live adapter (stable flash-sdk path).
 *
 * Design goal: one SOL-PERP long position, reconciled to an absolute USD target.
 * The Fuse worker NEVER assumes its last receipt is venue truth: getPosition()
 * is called before and after every mutation.
 *
 * Optional runtime deps (installed for live deployment only):
 *   flash-sdk, @coral-xyz/anchor, @solana/web3.js, bn.js
 */
export class FlashPerpAdapter {
  constructor(opts = {}) {
    this.opts = {
      cluster: 'devnet',
      poolName: 'devnet.1',
      targetSymbol: 'SOL',
      collateralSymbol: 'USDC',
      symbol: 'SOL-PERP',
      leverageX: 1,
      maxSlippageBps: 50,
      prioritizationFee: 0,
      minOrderUsd: 5,
      fillTimeoutMs: 15000,
      ...opts
    };
    this.ready = false;
  }

  async init() {
    const [web3, anchor, flash, BNmod] = await Promise.all([
      import('@solana/web3.js'),
      import('@coral-xyz/anchor'),
      import('flash-sdk'),
      import('bn.js')
    ]);
    const BN = BNmod.default || BNmod;
    const secret = JSON.parse(this.opts.privateKeyJson || '[]');
    if (!Array.isArray(secret) || secret.length < 32) throw new Error('FLASH_PRIVATE_KEY_JSON missing/invalid');
    if (!this.opts.rpcUrl) throw new Error('SOLANA_RPC_URL is required for Flash live mode');

    const kp = web3.Keypair.fromSecretKey(Uint8Array.from(secret));
    const wallet = new anchor.Wallet(kp);
    const connection = new web3.Connection(this.opts.rpcUrl, this.opts.commitment || 'confirmed');
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: this.opts.commitment || 'confirmed',
      preflightCommitment: this.opts.commitment || 'confirmed',
      skipPreflight: false
    });

    const pool = flash.PoolConfig.fromIdsByName(this.opts.poolName, this.opts.cluster);
    if (!pool) throw new Error(`Flash pool not found: ${this.opts.poolName}/${this.opts.cluster}`);
    // Flash's stable PoolConfig exposes trading custody metadata under `custodies`.
    // Use custodyAccount as the source of truth for market/position derivation rather
    // than relying on token metadata to carry venue-account addresses.
    const targetCustody = pool.custodies.find((c) => c.symbol === this.opts.targetSymbol);
    const collateralCustody = pool.custodies.find((c) => c.symbol === this.opts.collateralSymbol);
    if (!targetCustody) throw new Error(`Flash target custody ${this.opts.targetSymbol} not found in ${this.opts.poolName}`);
    if (!collateralCustody) throw new Error(`Flash collateral custody ${this.opts.collateralSymbol} not found in ${this.opts.poolName}`);

    const client = new flash.PerpetualsClient(
      provider,
      pool.programId,
      pool.perpComposibilityProgramId,
      pool.fbNftRewardProgramId,
      pool.rewardDistributionProgram?.programId,
      { prioritizationFee: Number(this.opts.prioritizationFee || 0) }
    );

    this.sdk = { ...flash, BN, web3 };
    this.provider = provider;
    this.wallet = wallet;
    this.connection = connection;
    this.pool = pool;
    this.client = client;
    this.targetCustody = targetCustody;
    this.collateralCustody = collateralCustody;
    const preferred = String(this.opts.side || 'long').toLowerCase() === 'short' ? flash.Side.Short : flash.Side.Long;
    const alternate = preferred === flash.Side.Long ? flash.Side.Short : flash.Side.Long;
    let side = preferred;
    let marketConfig = pool.getMarketConfig(targetCustody.custodyAccount, collateralCustody.custodyAccount, side);
    if (!marketConfig) {
      side = alternate;
      marketConfig = pool.getMarketConfig(targetCustody.custodyAccount, collateralCustody.custodyAccount, side);
    }
    if (!marketConfig) throw new Error(`No Flash ${this.opts.targetSymbol}/${this.opts.collateralSymbol} market in ${this.opts.poolName}`);
    this.side = side;
    this.sideName = side === flash.Side.Short ? 'short' : 'long';
    this.privilege = { none: {} };
    this.marketConfig = marketConfig;
    this.positionKey = client.getPositionKey(wallet.publicKey, targetCustody.custodyAccount, collateralCustody.custodyAccount, this.side);
    try { await client.loadAddressLookupTable(pool); } catch { /* lazy-loaded again before send */ }
    this.ready = true;
    return this;
  }

  async ensureReady() { if (!this.ready) await this.init(); }

  _usdBn(value) {
    const n = Math.max(0, Number(value));
    return new this.sdk.BN(Math.round(n * 1_000_000));
  }

  _usdFromBn(value) { return Number(value?.toString?.() || 0) / 1_000_000; }

  // Flash reports pnlWithFeeUsd as an i64 with 6 decimals. Anchor may hand it back already signed or as raw two's complement.
  _i64Usd(value) {
    if (value == null) return null;
    let n;
    try { n = BigInt(value.toString()); } catch { return null; }
    const signBit = 1n << 63n;
    if (n >= signBit) n -= 1n << 64n;
    return Number(n) / 1_000_000;
  }

  async _unrealizedPnlUsd(raw) {
    try {
      const data = await this.client.getPositionData(raw, this.pool, this.wallet.publicKey);
      const net = this._i64Usd(data?.pnlWithFeeUsd);
      if (net == null || !Number.isFinite(net)) return null;
      return net;
    } catch {
      return null;
    }
  }

  _mulDivBn(a, numerator, denominator) {
    const A = new this.sdk.BN(a.toString());
    const N = new this.sdk.BN(numerator.toString());
    const D = new this.sdk.BN(denominator.toString());
    if (D.isZero()) return new this.sdk.BN(0);
    return A.mul(N).div(D);
  }

  async _getRawPosition() {
    await this.ensureReady();
    try {
      const position = await this.client.getUserPosition(
        this.wallet.publicKey,
        this.targetCustody.custodyAccount,
        this.collateralCustody.custodyAccount,
        this.side
      );
      if (position && this._usdFromBn(position.sizeUsd) > 0) return position;
      return null;
    } catch (error) {
      const msg = String(error?.message || error);
      if (/not found|does not exist|AccountNotFound|could not find/i.test(msg)) return null;
      throw error;
    }
  }

  async _quoteClose(rawPosition, sizeDeltaUsd = undefined) {
    if (!rawPosition) return null;
    return this.client.getClosePositionQuote(
      this.positionKey,
      rawPosition,
      this.pool,
      sizeDeltaUsd === undefined ? undefined : this._usdBn(sizeDeltaUsd)
    );
  }

  async getPosition() {
    const raw = await this._getRawPosition();
    const ref = this.positionKey?.toBase58?.() || null;
    if (!raw || this._usdFromBn(raw.sizeUsd) <= 0) {
      return {
        venue: 'FLASH', symbol: this.opts.symbol, side: this.sideName, exposureUsd: 0, markPrice: null,
        unrealizedPnlUsd: 0, positionRef: ref
      };
    }
    let markPrice = null;
    try {
      const quote = await this._quoteClose(raw);
      const rawMark = quote?.markPrice?.price || quote?.markPrice || quote?.price || quote?.exitPrice;
      if (rawMark?.toString) markPrice = Number(rawMark.toString()) / 1_000_000;
    } catch { /* reconciliation does not depend on a mark */ }
    const pnl = await this._unrealizedPnlUsd(raw);
    return {
      venue: 'FLASH',
      symbol: this.opts.symbol,
      side: this.sideName,
      exposureUsd: this._usdFromBn(raw.sizeUsd),
      markPrice,
      unrealizedPnlUsd: pnl,
      positionRef: ref,
      sizeAmount: raw.sizeAmount?.toString?.() || null,
      sizeUsdRaw: raw.sizeUsd?.toString?.() || null
    };
  }

  async _alts() {
    const loaded = await this.client.getOrLoadAddressLookupTable(this.pool);
    return loaded?.addressLookupTables || this.client.addressLookupTables || [];
  }

  async _send(instructions, additionalSigners = []) {
    const alts = await this._alts();
    return this.client.sendTransaction(instructions, { additionalSigners, alts });
  }

  async _open(targetUsd) {
    const leverageX = Math.max(1, Number(this.opts.leverageX || 1));
    const collateralUi = Number(targetUsd) / leverageX;
    const amountIn = this.sdk.uiDecimalsToNative
      ? this.sdk.uiDecimalsToNative(collateralUi.toFixed(this.collateralCustody.decimals), this.collateralCustody.decimals)
      : new this.sdk.BN(Math.round(collateralUi * (10 ** this.collateralCustody.decimals)));
    const leverage = new this.sdk.BN(Math.round(leverageX * 10_000));
    const quote = await this.client.getOpenPositionQuote(amountIn, leverage, this.marketConfig, this.pool);
    if (!quote) throw new Error('Flash open quote unavailable');
    const entryPrice = quote.finalEntryPrice || quote.entryPrice || quote.markPrice;
    const collateral = quote.collateralAmount || amountIn;
    const size = quote.sizeAmount;
    if (!entryPrice || !size) throw new Error('Flash open quote missing price/size');
    const built = await this.client.openPosition(
      this.opts.targetSymbol,
      this.opts.collateralSymbol,
      entryPrice,
      collateral,
      size,
      this.side,
      this.pool,
      this.privilege
    );
    return this._send(built.instructions || built, built.additionalSigners || []);
  }

  async _increase(raw, deltaUsd) {
    const quote = await this._quoteClose(raw, deltaUsd);
    const mark = quote?.markPrice || quote?.price;
    if (!mark) throw new Error('Flash mark price unavailable for increase');
    const entryPx = this.client.getPriceAfterSlippage
      ? this.client.getPriceAfterSlippage(true, new this.sdk.BN(Number(this.opts.maxSlippageBps)), mark, this.side)
      : mark;
    const sizeDelta = this._mulDivBn(raw.sizeAmount, this._usdBn(deltaUsd), raw.sizeUsd);
    const built = await this.client.increaseSize(
      this.opts.targetSymbol,
      this.opts.collateralSymbol,
      this.positionKey,
      this.side,
      this.pool,
      entryPx,
      sizeDelta,
      this.privilege
    );
    return this._send(built.instructions || built, built.additionalSigners || []);
  }

  async _decrease(raw, deltaUsd) {
    const currentUsd = this._usdFromBn(raw.sizeUsd);
    if (deltaUsd >= currentUsd * 0.97) return this._close(raw);
    const quote = await this._quoteClose(raw, deltaUsd);
    const mark = quote?.markPrice || quote?.price;
    if (!mark) throw new Error('Flash mark price unavailable for decrease');
    const exitPx = this.client.getPriceAfterSlippage
      ? this.client.getPriceAfterSlippage(false, new this.sdk.BN(Number(this.opts.maxSlippageBps)), mark, this.side)
      : mark;
    const sizeDelta = this._mulDivBn(raw.sizeAmount, this._usdBn(deltaUsd), raw.sizeUsd);
    const built = await this.client.decreaseSize(
      this.opts.targetSymbol,
      this.opts.collateralSymbol,
      this.side,
      this.positionKey,
      this.pool,
      exitPx,
      sizeDelta,
      this.privilege
    );
    return this._send(built.instructions || built, built.additionalSigners || []);
  }

  async _close(raw) {
    const quote = await this._quoteClose(raw);
    const mark = quote?.markPrice || quote?.price;
    if (!mark) throw new Error('Flash mark price unavailable for close');
    const exitPx = this.client.getPriceAfterSlippage
      ? this.client.getPriceAfterSlippage(false, new this.sdk.BN(Number(this.opts.maxSlippageBps)), mark, this.side)
      : mark;
    const built = await this.client.closePosition(
      this.opts.targetSymbol,
      this.opts.collateralSymbol,
      exitPx,
      this.side,
      this.pool,
      this.privilege
    );
    return this._send(built.instructions || built, built.additionalSigners || []);
  }

  async _reconcile(before, expectedTarget) {
    const deadline = Date.now() + Number(this.opts.fillTimeoutMs || 15000);
    let after = before;
    do {
      await new Promise((r) => setTimeout(r, 600));
      after = await this.getPosition();
      if (Math.abs(Number(after.exposureUsd) - Number(expectedTarget)) <= Math.max(Number(this.opts.minOrderUsd || 5), Number(expectedTarget) * 0.05)) break;
    } while (Date.now() < deadline);
    return after;
  }

  async executeTarget(targetUsd, { clientOrderId, reduceOnly = false } = {}) {
    await this.ensureReady();
    const target = Number(targetUsd);
    if (!Number.isFinite(target) || target < 0) throw new Error('Flash v1 Fuse adapter supports non-negative SOL targets only');

    const before = await this.getPosition();
    const actual = Number(before.exposureUsd || 0);
    let desired = target;
    if (reduceOnly && desired > actual) desired = actual;
    const delta = desired - actual;
    const minUsd = Number(this.opts.minOrderUsd || 5);
    if (Math.abs(delta) < minUsd) {
      return { ok: true, txSignature: null, venueRef: before.positionRef || clientOrderId || null, before, after: before, deltaUsd: 0, reconciled: true };
    }

    const raw = await this._getRawPosition();
    let txSignature;
    if (desired === 0) {
      if (!raw) return { ok: true, txSignature: null, venueRef: before.positionRef || null, before, after: before, deltaUsd: 0, reconciled: true };
      txSignature = await this._close(raw);
    } else if (!raw || actual <= 0) {
      txSignature = await this._open(desired);
    } else if (delta > 0) {
      txSignature = await this._increase(raw, delta);
    } else {
      txSignature = await this._decrease(raw, Math.abs(delta));
    }

    const after = await this._reconcile(before, desired);
    return {
      ok: true,
      txSignature: typeof txSignature === 'string' ? txSignature : (txSignature?.signature || txSignature?.txid || String(txSignature)),
      venueRef: after.positionRef || before.positionRef || clientOrderId || null,
      before,
      after,
      deltaUsd: Number(after.exposureUsd || 0) - actual,
      reconciled: true
    };
  }

  async close({ clientOrderId } = {}) { return this.executeTarget(0, { clientOrderId, reduceOnly: true }); }
}

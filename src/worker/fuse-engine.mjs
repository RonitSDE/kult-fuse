import { makeProbabilityMark, explainSignal } from '../core/probability.mjs';
import { hysteresisTarget } from '../core/policy.mjs';
import { evaluateRisk, lossStopHit } from '../core/risk.mjs';
import { createReceipt } from '../core/receipt.mjs';
import { FuseStatus, Reason } from '../core/constants.mjs';

function reasonFor(before, after, killed, override) {
  if (override) return override;
  if (killed) return Reason.KILL_PROBABILITY;
  if (after > before) return before === 0 ? Reason.INITIAL_OPEN : Reason.PROBABILITY_STEP_UP;
  if (after < before) return Reason.PROBABILITY_STEP_DOWN;
  return Reason.NOOP;
}

export class FuseEngine {
  constructor({ fuse, eventSource, perpAdapter, persist, appendReceipt, chainHooks = null }) {
    this.fuse = fuse;
    this.eventSource = eventSource;
    this.perp = perpAdapter;
    this.persist = persist || (async () => {});
    this.appendReceipt = appendReceipt || (async () => {});
    this.confirmation = { targetUsd: null, count: 0 };
    this.busy = false;
    this.chainHooks = chainHooks;
    this.chainWarning = null;
    this.pendingChainTxs = [];
  }

  // Runs one onchain commitment and keeps its signature for receipts and explorer links.
  async chain(ix, fn) {
    const signature = await fn();
    if (typeof signature === 'string') {
      const tx = { ix, signature, at: Date.now() };
      this.fuse.chainTxs = [...(this.fuse.chainTxs || []), tx].slice(-100);
      this.pendingChainTxs.push(tx);
    }
    return signature;
  }

  async arm() {
    if (this.fuse.status !== FuseStatus.PROPOSED) throw new Error('only PROPOSED Fuse can be armed');
    if (this.chainHooks?.arm) await this.chain('arm_fuse', () => this.chainHooks.arm());
    this.fuse.status = FuseStatus.ARMED;
    this.fuse.updatedAt = Date.now();
    await this.persist(this.fuse);
    return this.snapshot();
  }

  async kill(reason = Reason.EMERGENCY_KILL) {
    if (this.fuse.status === FuseStatus.SETTLED) throw new Error('settled');
    if (this.chainHooks) {
      try {
        if (reason === Reason.KILL_PROBABILITY && this.chainHooks.killProbability) await this.chain('trigger_probability_kill', () => this.chainHooks.killProbability());
        else if (this.chainHooks.killAuthorized) await this.chain('trigger_authorized_kill', () => this.chainHooks.killAuthorized(reason));
        // A manual kill must commit a new zero target/nonce before a venue close
        // can be attached to exactly one onchain receipt.
        if (this.chainHooks.setTarget) {
          const nonce = ++this.fuse.executionNonce;
          await this.chain('set_target', () => this.chainHooks.setTarget({ targetUsd: 0, nonce, reason }));
          this.fuse.pendingExecutionNonce = nonce;
          this.fuse.pendingTargetExposureUsd = 0;
        }
        this.chainWarning = null;
      } catch (e) { this.chainWarning = `kill commitment failed: ${e.message}`; }
    }
    this.fuse.status = FuseStatus.KILLED;
    this.fuse.desiredExposureUsd = 0;
    this.fuse.pendingTargetExposureUsd = 0;
    this.fuse.lastReasonCode = reason;
    this.fuse.killedAt ||= Date.now();
    await this.persist(this.fuse);
    return this.reconcile({ force: true, reason });
  }

  // Venue P&L (fees included) crossed the configured stop: block increases, close, and keep the trigger evidence.
  // The threshold is a trigger, not a guaranteed maximum loss; the close fills at whatever the venue gives.
  async triggerLossStop(position, pnlUsd) {
    this.fuse.lossStop = {
      thresholdUsd: -Math.abs(this.fuse.policy.lossStopUsd),
      triggerPnlUsd: pnlUsd,
      positionUsd: Number(position.exposureUsd || 0),
      markPrice: position.markPrice ?? null,
      triggeredAt: Date.now()
    };
    const out = await this.kill(Reason.LOSS_STOP);
    Object.assign(this.fuse.lossStop, {
      closeReceiptHash: out.receipt?.hash || null,
      closeTxSignature: out.exec?.txSignature || null,
      residualUsd: Number(out.position?.exposureUsd || 0)
    });
    await this.persist(this.fuse);
    return { ...out, lossStop: this.fuse.lossStop, ...this.snapshot() };
  }

  async tick(rawObservation = null) {
    if (this.busy) return { skipped: true, reason: 'BUSY', ...this.snapshot() };
    this.busy = true;
    try {
      if (![FuseStatus.ARMED, FuseStatus.OPEN, FuseStatus.REDUCING].includes(this.fuse.status)) {
        if (this.fuse.status === FuseStatus.KILLED) {
          const position = await this.perp.getPosition();
          if (Math.abs(Number(position.exposureUsd || 0)) < 0.01) return { skipped: true, reason: 'STATE_KILLED', ...this.snapshot(), position };
          return this.reconcile({ force: true, reason: this.fuse.lastReasonCode || Reason.RECONCILE });
        }
        return { skipped: true, reason: `STATE_${this.fuse.status}`, ...this.snapshot() };
      }

      // Expiry is a clock condition, independent of the event feed. Commit the
      // absorbing kill before attempting the venue close, even when a quote is
      // stale, missing or the market API is unavailable.
      if (Math.floor(Date.now() / 1000) > this.fuse.policy.expiryTs) {
        return await this.kill(Reason.EXPIRY_CLOSE);
      }

      // The loss stop reads venue P&L before anything else, so a stale quote or an oracle outage cannot delay it.
      const actual = await this.perp.getPosition();
      const pnl = actual.unrealizedPnlUsd == null ? null : Number(actual.unrealizedPnlUsd);
      this.fuse.lastPnlUsd = pnl;
      if (lossStopHit(this.fuse.policy, pnl)) return await this.triggerLossStop(actual, pnl);

      const raw = rawObservation || await this.eventSource.read();
      if (raw.sequence <= this.fuse.oracleSequence) throw new Error('oracle replay rejected');
      const mark = makeProbabilityMark(raw, this.fuse.policy);
      this.fuse.oracleSequence = raw.sequence;
      this.fuse.lastProbabilityBps = mark.pBps;
      this.fuse.lastSignal = { bid: mark.bid, ask: mark.ask, spreadBps: mark.spreadBps, ageSec: mark.ageSec, depthUsd: mark.depthUsd, observedAtMs: mark.observedAtMs, quality: mark.quality, qualityReason: mark.qualityReason, source: mark.source, explain: explainSignal(mark, this.fuse.policy, this.fuse.desiredExposureUsd) };
      this.fuse.updatedAt = Date.now();

      if (!mark.quality) {
        this.fuse.lastReasonCode = { STALE: Reason.ORACLE_STALE, WIDE: Reason.ORACLE_WIDE, THIN: Reason.ORACLE_THIN }[mark.qualityReason];
        await this.persist(this.fuse);
        return { skipped: true, reason: this.fuse.lastReasonCode, mark, ...this.snapshot() };
      }

      const curve = hysteresisTarget(this.fuse.policy, mark.pBps, this.fuse.desiredExposureUsd);

      // Confirmation/debounce: kills bypass debounce; ordinary band changes require N consistent observations.
      let proposed = curve.targetUsd;
      if (!curve.killed && proposed !== this.fuse.desiredExposureUsd) {
        if (this.confirmation.targetUsd === proposed) this.confirmation.count += 1;
        else this.confirmation = { targetUsd: proposed, count: 1 };
        if (this.confirmation.count < this.fuse.policy.confirmationCount) {
          await this.persist(this.fuse);
          return { skipped: true, reason: 'AWAITING_CONFIRMATION', mark, candidateTargetUsd: proposed, confirmationCount: this.confirmation.count, ...this.snapshot() };
        }
      } else this.confirmation = { targetUsd: null, count: 0 };

      const risk = evaluateRisk({ fuse: this.fuse, proposedTargetUsd: proposed, unrealizedPnlUsd: pnl });
      proposed = risk.kill ? 0 : risk.targetUsd;
      const killing = curve.killed || risk.kill;

      // Unchanged target: nothing new to commit onchain; only keep the venue reconciled.
      if (!killing && proposed === this.fuse.desiredExposureUsd) {
        this.fuse.lastReasonCode = Reason.NOOP;
        await this.persist(this.fuse);
        return this.reconcile({ mark, reason: Reason.NOOP });
      }

      const { chainTxs: _keep, ...uncommitted } = this.fuse;
      const rollback = structuredClone(uncommitted);
      if (killing) {
        this.fuse.status = FuseStatus.KILLED;
        this.fuse.killedAt ||= Date.now();
      }
      const beforeTarget = this.fuse.desiredExposureUsd;
      this.fuse.desiredExposureUsd = proposed;
      this.fuse.lastMarkPrice = Number(actual.markPrice || 0);
      this.fuse.executionNonce += 1;
      this.fuse.pendingExecutionNonce = this.fuse.executionNonce;
      this.fuse.pendingTargetExposureUsd = proposed;
      this.fuse.lastReasonCode = reasonFor(beforeTarget, proposed, curve.killed, risk.reason);
      const reducingRisk = Math.abs(proposed) <= Math.abs(Number(actual.exposureUsd || 0)) || proposed === 0;
      if (this.chainHooks) {
        try {
          if (this.chainHooks.acceptObservation) {
            const markPrice = Math.round(Number(actual.markPrice || 0) * 1e6);
            await this.chain('accept_observation', () => this.chainHooks.acceptObservation({ pBps: mark.pBps, markPrice, sequence: raw.sequence, observedTs: Math.floor(mark.observedAtMs/1000) }));
          }
          if (curve.killed && this.chainHooks.killProbability) await this.chain('trigger_probability_kill', () => this.chainHooks.killProbability());
          else if (risk.kill && this.chainHooks.killAuthorized) await this.chain('trigger_authorized_kill', () => this.chainHooks.killAuthorized(this.fuse.lastReasonCode));
          if (this.chainHooks.setTarget) await this.chain('set_target', () => this.chainHooks.setTarget({ targetUsd: proposed, nonce: this.fuse.executionNonce, reason: this.fuse.lastReasonCode }));
          this.chainWarning = null;
        } catch (e) {
          if (!reducingRisk) {
            // A risk increase the chain has not authorized must not reach the venue: undo it locally.
            // Keep the spent nonce, since a timed-out tx may still have landed and a reused nonce would be rejected as replay.
            const { executionNonce } = this.fuse;
            Object.assign(this.fuse, rollback, { executionNonce, pendingExecutionNonce: 0, pendingTargetExposureUsd: 0 });
            this.pendingChainTxs = [];
            this.chainWarning = `risk increase not committed onchain, will retry: ${e.message}`;
            await this.persist(this.fuse);
            throw e;
          }
          this.chainWarning = `risk-reducing chain commitment pending: ${e.message}`;
        }
      }
      await this.persist(this.fuse);

      return this.reconcile({ mark, reason: this.fuse.lastReasonCode });
    } finally { this.busy = false; }
  }

  async reconcile({ force = false, reason = Reason.RECONCILE, mark = null } = {}) {
    const before = await this.perp.getPosition();
    const desired = this.fuse.status === FuseStatus.KILLED ? 0 : this.fuse.desiredExposureUsd;
    const delta = desired - Number(before.exposureUsd || 0);

    // A kill of an already-flat mandate should not send a zero-sized venue
    // order or invent an execution receipt.
    if (desired === 0 && Math.abs(Number(before.exposureUsd || 0)) < 0.01) {
      this.fuse.filledExposureUsd = Number(before.exposureUsd || 0);
      this.fuse.pendingExecutionNonce = 0;
      this.fuse.pendingTargetExposureUsd = 0;
      await this.persist(this.fuse);
      return { executed: false, deltaUsd: delta, mark, ...this.snapshot(), position: before };
    }

    if (!force && Math.abs(delta) < this.fuse.policy.minRebalanceUsd) {
      this.fuse.filledExposureUsd = Number(before.exposureUsd || 0);
      this.fuse.pendingExecutionNonce = 0;
      this.fuse.pendingTargetExposureUsd = 0;
      await this.persist(this.fuse);
      return { executed: false, deltaUsd: delta, mark, ...this.snapshot(), position: before };
    }

    let nonce = this.fuse.pendingExecutionNonce;
    if (!nonce) {
      nonce = ++this.fuse.executionNonce;
      if (this.chainHooks?.setTarget) {
        try {
          await this.chain('set_target', () => this.chainHooks.setTarget({ targetUsd: desired, nonce, reason }));
        } catch (e) {
          this.chainWarning = `reconciliation target not committed: ${e.message}`;
          if (Math.abs(desired) > Math.abs(Number(before.exposureUsd || 0)) + 0.01) {
            await this.persist(this.fuse);
            throw e;
          }
        }
      }
      this.fuse.pendingExecutionNonce = nonce;
      this.fuse.pendingTargetExposureUsd = desired;
      await this.persist(this.fuse);
    }
    const clientOrderId = `${this.fuse.id}:${nonce}:${desired}`;
    const exec = await this.perp.executeTarget(desired, { clientOrderId, reduceOnly: this.fuse.status === FuseStatus.KILLED || Math.abs(desired) < Math.abs(before.exposureUsd || 0) });
    const actual = await this.perp.getPosition();
    const baseChanged = before.baseAmount != null && actual.baseAmount != null
      ? Math.abs(Number(actual.baseAmount) - Number(before.baseAmount)) > 1e-9
      : Math.abs(Number(actual.exposureUsd || 0) - Number(before.exposureUsd || 0)) >= 0.01;
    if (!exec.txSignature || !baseChanged) {
      this.chainWarning = 'Venue did not produce a position fill; no execution receipt was created.';
      this.fuse.filledExposureUsd = Number(actual.exposureUsd || 0);
      await this.persist(this.fuse);
      return { executed: false, pending: true, reason: 'NO_VENUE_FILL', mark, ...this.snapshot(), position: actual };
    }

    const oldFilled = this.fuse.filledExposureUsd;
    this.fuse.filledExposureUsd = Number(actual.exposureUsd || 0);
    this.fuse.lastMarkPrice = Number(actual.markPrice || this.fuse.lastMarkPrice || 0);
    this.fuse.pendingExecutionNonce = 0;
    this.fuse.pendingTargetExposureUsd = 0;

    if (this.fuse.status !== FuseStatus.KILLED) {
      if (Math.abs(this.fuse.filledExposureUsd) > 0) {
        this.fuse.status = Math.abs(this.fuse.filledExposureUsd) < Math.abs(oldFilled) ? FuseStatus.REDUCING : FuseStatus.OPEN;
      }
    }

    const receipt = createReceipt({
      fuseId: this.fuse.id,
      sequence: nonce,
      prevReceiptHash: this.fuse.lastReceiptHash,
      observedProbabilityBps: this.fuse.lastProbabilityBps,
      desiredExposureBeforeUsd: oldFilled,
      desiredExposureAfterUsd: desired,
      actualExposureBeforeUsd: Number(before.exposureUsd || 0),
      filledExposureAfterUsd: this.fuse.filledExposureUsd,
      baseAmountBefore: before.baseAmount,
      baseAmountAfter: actual.baseAmount,
      marketId: actual.symbol || this.fuse.policy.marketId,
      markPrice: this.fuse.lastMarkPrice,
      reason: reason || this.fuse.lastReasonCode,
      venue: actual.venue || this.fuse.policy.venue,
      venueRef: exec.venueRef,
      venueCluster: exec.cluster || actual.cluster || null,
      txSignature: exec.txSignature,
      fuseStatus: this.fuse.status,
      unrealizedPnlUsd: actual.unrealizedPnlUsd ?? null,
      residualUsd: desired - this.fuse.filledExposureUsd,
      policyHash: this.fuse.policyHash
    });
    this.fuse.lastReceiptHash = receipt.hash;
    this.fuse.lastReasonCode = receipt.reason;
    // A fill whose receipt never reached the chain stays visible as unanchored; the verifier must not pass it.
    receipt.anchor = { status: 'NONE' };
    if (this.chainHooks?.recordFill) {
      try {
        const anchorSig = await this.chain('record_fill', () => this.chainHooks.recordFill({ filledExposureUsd: this.fuse.filledExposureUsd, venueRef: exec.venueRef || exec.txSignature || '', receiptHash: receipt.hash, nonce, reason: receipt.reason }));
        receipt.anchor = { status: 'ANCHORED', signature: anchorSig };
        this.chainWarning = null;
      } catch (e) {
        // Never re-execute a venue order merely because receipt anchoring failed. Reconciliation wins.
        receipt.anchor = { status: 'FAILED', error: e.message };
        this.chainWarning = `receipt anchoring pending: ${e.message}`;
      }
    }
    // Chain signatures only exist after the receipt is hashed, so they sit outside the hashed body.
    if (this.pendingChainTxs.length) receipt.chain = { txs: this.pendingChainTxs };
    this.pendingChainTxs = [];
    await this.appendReceipt(receipt);
    await this.persist(this.fuse);
    return { executed: true, exec, receipt, mark, ...this.snapshot(), position: actual };
  }

  async settle() {
    const pos = await this.perp.getPosition();
    if (Math.abs(Number(pos.exposureUsd || 0)) >= 0.01) throw new Error('cannot settle with nonzero exposure');
    if (![FuseStatus.KILLED, FuseStatus.ARMED, FuseStatus.OPEN, FuseStatus.REDUCING].includes(this.fuse.status)) throw new Error('invalid settle state');
    if (this.chainHooks?.settle) await this.chain('settle_fuse', () => this.chainHooks.settle());
    this.fuse.status = FuseStatus.SETTLED;
    this.fuse.settledAt = Date.now();
    this.fuse.desiredExposureUsd = 0;
    this.fuse.filledExposureUsd = 0;
    await this.persist(this.fuse);
    return this.snapshot();
  }

  snapshot() { const out=JSON.parse(JSON.stringify(this.fuse)); out.chainWarning=this.chainWarning; return out; }
}

import { makeProbabilityMark } from '../core/probability.mjs';
import { hysteresisTarget } from '../core/policy.mjs';
import { evaluateRisk } from '../core/risk.mjs';
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
  }

  async arm() {
    if (this.fuse.status !== FuseStatus.PROPOSED) throw new Error('only PROPOSED Fuse can be armed');
    if (this.chainHooks?.arm) await this.chainHooks.arm();
    this.fuse.status = FuseStatus.ARMED;
    this.fuse.updatedAt = Date.now();
    await this.persist(this.fuse);
    return this.snapshot();
  }

  async kill(reason = Reason.EMERGENCY_KILL) {
    if (this.fuse.status === FuseStatus.SETTLED) throw new Error('settled');
    if (this.chainHooks) {
      try {
        if (reason === Reason.KILL_PROBABILITY && this.chainHooks.killProbability) await this.chainHooks.killProbability();
        else if (this.chainHooks.killAuthorized) await this.chainHooks.killAuthorized(reason);
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

  async tick(rawObservation = null) {
    if (this.busy) return { skipped: true, reason: 'BUSY', ...this.snapshot() };
    this.busy = true;
    try {
      if (![FuseStatus.ARMED, FuseStatus.OPEN, FuseStatus.REDUCING].includes(this.fuse.status)) {
        return { skipped: true, reason: `STATE_${this.fuse.status}`, ...this.snapshot() };
      }

      const raw = rawObservation || await this.eventSource.read();
      if (raw.sequence <= this.fuse.oracleSequence) throw new Error('oracle replay rejected');
      const mark = makeProbabilityMark(raw, this.fuse.policy);
      if (this.chainHooks?.acceptObservation) {
        await this.chainHooks.acceptObservation({ pBps: mark.pBps, markPrice: Math.round(Number((await this.perp.getPosition()).markPrice || 0) * 1e6), sequence: raw.sequence, observedTs: Math.floor(mark.observedAtMs/1000) });
      }
      this.fuse.oracleSequence = raw.sequence;
      this.fuse.lastProbabilityBps = mark.pBps;
      this.fuse.lastSignal = { bid: mark.bid, ask: mark.ask, spreadBps: mark.spreadBps, ageSec: mark.ageSec, quality: mark.quality, qualityReason: mark.qualityReason, source: mark.source };
      this.fuse.updatedAt = Date.now();

      if (!mark.quality) {
        this.fuse.lastReasonCode = mark.qualityReason === 'STALE' ? Reason.ORACLE_STALE : Reason.ORACLE_WIDE;
        await this.persist(this.fuse);
        return { skipped: true, reason: this.fuse.lastReasonCode, mark, ...this.snapshot() };
      }

      const curve = hysteresisTarget(this.fuse.policy, mark.pBps, this.fuse.desiredExposureUsd);
      if (curve.killed) {
        this.fuse.status = FuseStatus.KILLED;
        this.fuse.killedAt ||= Date.now();
      }

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

      const actual = await this.perp.getPosition();
      const risk = evaluateRisk({ fuse: this.fuse, proposedTargetUsd: proposed, unrealizedPnlUsd: Number(actual.unrealizedPnlUsd || 0) });
      if (risk.kill) {
        this.fuse.status = FuseStatus.KILLED;
        this.fuse.killedAt ||= Date.now();
        proposed = 0;
      } else proposed = risk.targetUsd;

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
          if (curve.killed && this.chainHooks.killProbability) await this.chainHooks.killProbability();
          else if (risk.kill && this.chainHooks.killAuthorized) await this.chainHooks.killAuthorized(this.fuse.lastReasonCode);
          if (this.chainHooks.setTarget) await this.chainHooks.setTarget({ targetUsd: proposed, nonce: this.fuse.executionNonce, reason: this.fuse.lastReasonCode });
          this.chainWarning = null;
        } catch (e) {
          if (!reducingRisk) throw e;
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

    if (!force && Math.abs(delta) < this.fuse.policy.minRebalanceUsd) {
      this.fuse.filledExposureUsd = Number(before.exposureUsd || 0);
      this.fuse.pendingExecutionNonce = 0;
      this.fuse.pendingTargetExposureUsd = 0;
      await this.persist(this.fuse);
      return { executed: false, deltaUsd: delta, mark, ...this.snapshot(), position: before };
    }

    const nonce = this.fuse.pendingExecutionNonce || ++this.fuse.executionNonce;
    const clientOrderId = `${this.fuse.id}:${nonce}:${desired}`;
    const exec = await this.perp.executeTarget(desired, { clientOrderId, reduceOnly: this.fuse.status === FuseStatus.KILLED || Math.abs(desired) < Math.abs(before.exposureUsd || 0) });
    const actual = await this.perp.getPosition();

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
      markPrice: this.fuse.lastMarkPrice,
      reason: reason || this.fuse.lastReasonCode,
      venue: actual.venue || this.fuse.policy.venue,
      venueRef: exec.venueRef,
      txSignature: exec.txSignature,
      policyHash: this.fuse.policyHash
    });
    this.fuse.lastReceiptHash = receipt.hash;
    this.fuse.lastReasonCode = receipt.reason;
    if (this.chainHooks?.recordFill) {
      try {
        await this.chainHooks.recordFill({ filledExposureUsd: this.fuse.filledExposureUsd, venueRef: exec.venueRef || exec.txSignature || '', receiptHash: receipt.hash, nonce, reason: receipt.reason });
        this.chainWarning = null;
      } catch (e) {
        // Never re-execute a venue order merely because receipt anchoring failed. Reconciliation wins.
        this.chainWarning = `receipt anchoring pending: ${e.message}`;
      }
    }
    await this.appendReceipt(receipt);
    await this.persist(this.fuse);
    return { executed: true, exec, receipt, mark, ...this.snapshot(), position: actual };
  }

  async settle() {
    const pos = await this.perp.getPosition();
    if (Math.abs(Number(pos.exposureUsd || 0)) >= 0.01) throw new Error('cannot settle with nonzero exposure');
    if (![FuseStatus.KILLED, FuseStatus.ARMED, FuseStatus.OPEN, FuseStatus.REDUCING].includes(this.fuse.status)) throw new Error('invalid settle state');
    if (this.chainHooks?.settle) await this.chainHooks.settle();
    this.fuse.status = FuseStatus.SETTLED;
    this.fuse.settledAt = Date.now();
    this.fuse.desiredExposureUsd = 0;
    this.fuse.filledExposureUsd = 0;
    await this.persist(this.fuse);
    return this.snapshot();
  }

  snapshot() { const out=JSON.parse(JSON.stringify(this.fuse)); out.chainWarning=this.chainWarning; return out; }
}

use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWxTWqozVBXzUBRrk4GkC8KQQkSy");

const ZERO_HASH: [u8; 32] = [0u8; 32];
const MAX_CURVE_STEPS: usize = 5;

#[program]
pub mod kult_fuse {
    use super::*;

    pub fn init_fuse(ctx: Context<InitFuse>, fuse_id: u64, p: InitFuseParams) -> Result<()> {
        require!(p.risk_cap_usd > 0, FuseError::InvalidRiskCap);
        require!(p.kill_probability_bps <= 10_000, FuseError::InvalidProbability);
        require!(p.max_oracle_age_sec > 0, FuseError::InvalidOracleAge);
        require!(p.step_count > 0 && (p.step_count as usize) <= MAX_CURVE_STEPS, FuseError::InvalidCurve);
        validate_curve(&p)?;
        let clock = Clock::get()?;
        require!(p.expiry_ts > clock.unix_timestamp, FuseError::AlreadyExpired);

        let f = &mut ctx.accounts.fuse;
        f.fuse_id = fuse_id;
        f.owner = ctx.accounts.owner.key();
        f.agent = p.agent;
        f.execution_authority = p.execution_authority;
        f.oracle_authority = p.oracle_authority;
        f.event_market = p.event_market;
        f.outcome_id = p.outcome_id;
        f.oracle_kind = p.oracle_kind;
        f.curve_hash = p.curve_hash;
        f.curve_version = p.curve_version;
        f.step_count = p.step_count;
        f.step_thresholds_bps = p.step_thresholds_bps;
        f.step_exposures_usd = p.step_exposures_usd;
        f.risk_cap_usd = p.risk_cap_usd;
        f.max_leverage_bps = p.max_leverage_bps;
        f.kill_probability_bps = p.kill_probability_bps;
        f.hysteresis_bps = p.hysteresis_bps;
        f.max_oracle_age_sec = p.max_oracle_age_sec;
        f.loss_stop_usd = p.loss_stop_usd;
        f.expiry_ts = p.expiry_ts;
        f.venue = p.venue;
        f.market_id = p.market_id;
        f.status = FuseStatus::Proposed;
        f.desired_exposure_usd = 0;
        f.filled_exposure_usd = 0;
        f.last_probability_bps = 0;
        f.last_mark_price = 0;
        f.oracle_sequence = 0;
        f.execution_nonce = 0;
        f.pending_execution_nonce = 0;
        f.pending_target_exposure_usd = 0;
        f.last_update_slot = clock.slot;
        f.last_receipt_hash = ZERO_HASH;
        f.last_reason_code = ReasonCode::Noop as u8;
        f.position_ref = ZERO_HASH;
        f.bump = ctx.bumps.fuse;

        emit!(FuseInitialized { fuse: f.key(), owner: f.owner, curve_hash: f.curve_hash, risk_cap_usd: f.risk_cap_usd });
        Ok(())
    }

    pub fn arm_fuse(ctx: Context<OwnerFuse>) -> Result<()> {
        let f = &mut ctx.accounts.fuse;
        require!(f.status == FuseStatus::Proposed, FuseError::InvalidState);
        require!(Clock::get()?.unix_timestamp < f.expiry_ts, FuseError::AlreadyExpired);
        f.status = FuseStatus::Armed;
        emit!(FuseArmed { fuse: f.key() });
        Ok(())
    }

    pub fn cancel_fuse(ctx: Context<OwnerFuse>) -> Result<()> {
        let f = &mut ctx.accounts.fuse;
        require!(matches!(f.status, FuseStatus::Proposed | FuseStatus::Armed), FuseError::InvalidState);
        require!(f.filled_exposure_usd == 0, FuseError::NonZeroExposure);
        f.status = FuseStatus::Settled;
        f.desired_exposure_usd = 0;
        f.last_reason_code = ReasonCode::OwnerCancel as u8;
        emit!(FuseSettled { fuse: f.key() });
        Ok(())
    }

    pub fn accept_observation(ctx: Context<OracleFuse>, p_bps: u16, mark_price: u64, oracle_sequence: u64, observed_ts: i64) -> Result<()> {
        let f = &mut ctx.accounts.fuse;
        require!(matches!(f.status, FuseStatus::Armed | FuseStatus::Open | FuseStatus::Reducing), FuseError::InvalidState);
        require!(p_bps <= 10_000, FuseError::InvalidProbability);
        require!(oracle_sequence > f.oracle_sequence, FuseError::Replay);
        let clock = Clock::get()?;
        require!(observed_ts <= clock.unix_timestamp + 5, FuseError::FutureObservation);
        let age = clock.unix_timestamp.saturating_sub(observed_ts);
        require!(age as u32 <= f.max_oracle_age_sec, FuseError::StaleOracle);

        f.last_probability_bps = p_bps;
        f.last_mark_price = mark_price;
        f.oracle_sequence = oracle_sequence;
        f.last_update_slot = clock.slot;
        emit!(ObservationAccepted { fuse: f.key(), p_bps, mark_price, oracle_sequence });
        Ok(())
    }

    /// Verifies the worker's requested target against the committed curve onchain.
    /// Normal probability-driven changes must match the deterministic curve exactly.
    /// Explicit risk-reducing reasons may only reduce absolute exposure.
    pub fn set_target(ctx: Context<ExecutionFuse>, target_exposure_usd: i64, execution_nonce: u64, reason_code: u8) -> Result<()> {
        let f = &mut ctx.accounts.fuse;
        require!(matches!(f.status, FuseStatus::Armed | FuseStatus::Open | FuseStatus::Reducing | FuseStatus::Killed), FuseError::InvalidState);
        require!(execution_nonce > f.execution_nonce, FuseError::Replay);
        require!(target_exposure_usd.unsigned_abs() <= f.risk_cap_usd, FuseError::RiskCapExceeded);

        let now = Clock::get()?.unix_timestamp;
        if f.status == FuseStatus::Killed {
            require!(target_exposure_usd == 0, FuseError::KilledCanOnlyClose);
        } else if f.last_probability_bps < f.kill_probability_bps {
            // Probability kill is absorbing and cannot be bypassed by the worker.
            require!(target_exposure_usd == 0, FuseError::PolicyExecutionMismatch);
            kill_state(f, ReasonCode::KillProbability as u8)?;
        } else if now > f.expiry_ts {
            require!(is_risk_reducing(f.filled_exposure_usd, target_exposure_usd), FuseError::ExpiredCanOnlyReduce);
        } else {
            let expected = expected_target_with_hysteresis(f, f.last_probability_bps) as i64;
            let deterministic_reason = matches!(
                reason_code,
                x if x == ReasonCode::InitialOpen as u8
                    || x == ReasonCode::ProbabilityStepUp as u8
                    || x == ReasonCode::ProbabilityStepDown as u8
                    || x == ReasonCode::Noop as u8
            );

            if deterministic_reason {
                require!(target_exposure_usd == expected, FuseError::PolicyExecutionMismatch);
            } else {
                // Loss-stop / expiry-style controls may be more conservative than the curve,
                // but can never increase risk beyond the curve-authorized target.
                require!(is_safe_relative_to_expected(expected, target_exposure_usd), FuseError::UnsafeRiskIncrease);
            }

            emit!(PolicyTargetVerified {
                fuse: f.key(),
                probability_bps: f.last_probability_bps,
                expected_target_usd: expected,
                submitted_target_usd: target_exposure_usd,
                reason_code,
            });
        }

        f.desired_exposure_usd = target_exposure_usd;
        f.execution_nonce = execution_nonce;
        f.pending_execution_nonce = execution_nonce;
        f.pending_target_exposure_usd = target_exposure_usd;
        f.last_reason_code = reason_code;
        emit!(TargetSet { fuse: f.key(), target_exposure_usd, execution_nonce, reason_code });
        Ok(())
    }

    pub fn trigger_probability_kill(ctx: Context<ExecutionFuse>) -> Result<()> {
        let f = &mut ctx.accounts.fuse;
        require!(f.status != FuseStatus::Settled, FuseError::InvalidState);
        require!(f.last_probability_bps < f.kill_probability_bps, FuseError::KillConditionNotMet);
        kill_state(f, ReasonCode::KillProbability as u8)?;
        Ok(())
    }

    pub fn trigger_authorized_kill(ctx: Context<ExecutionFuse>, reason_code: u8) -> Result<()> {
        let f = &mut ctx.accounts.fuse;
        require!(f.status != FuseStatus::Settled, FuseError::InvalidState);
        // Used for attested v1 conditions such as a loss-stop or venue-health failure.
        kill_state(f, reason_code)?;
        Ok(())
    }

    pub fn record_fill(ctx: Context<ExecutionFuse>, filled_exposure_usd: i64, position_ref: [u8; 32], receipt_hash: [u8; 32], execution_nonce: u64, reason_code: u8) -> Result<()> {
        let f = &mut ctx.accounts.fuse;
        require!(execution_nonce == f.pending_execution_nonce || (f.pending_execution_nonce == 0 && execution_nonce == f.execution_nonce), FuseError::ExecutionNonceMismatch);
        if f.status == FuseStatus::Killed {
            require!(is_risk_reducing(f.filled_exposure_usd, filled_exposure_usd), FuseError::KilledCanOnlyClose);
        }

        let old_abs = f.filled_exposure_usd.unsigned_abs();
        let new_abs = filled_exposure_usd.unsigned_abs();
        f.filled_exposure_usd = filled_exposure_usd;
        f.position_ref = position_ref;
        f.last_receipt_hash = receipt_hash;
        f.last_reason_code = reason_code;
        f.pending_execution_nonce = 0;
        f.pending_target_exposure_usd = 0;

        if f.status != FuseStatus::Killed && new_abs > 0 {
            f.status = if old_abs > 0 && new_abs < old_abs { FuseStatus::Reducing } else { FuseStatus::Open };
        }
        emit!(FillRecorded { fuse: f.key(), filled_exposure_usd, execution_nonce, receipt_hash, reason_code });
        Ok(())
    }

    pub fn settle_fuse(ctx: Context<OwnerFuse>) -> Result<()> {
        let f = &mut ctx.accounts.fuse;
        require!(f.filled_exposure_usd == 0, FuseError::NonZeroExposure);
        require!(f.status != FuseStatus::Proposed, FuseError::InvalidState);
        f.status = FuseStatus::Settled;
        f.desired_exposure_usd = 0;
        f.pending_target_exposure_usd = 0;
        f.pending_execution_nonce = 0;
        f.last_reason_code = ReasonCode::Settlement as u8;
        emit!(FuseSettled { fuse: f.key() });
        Ok(())
    }
}

fn validate_curve(p: &InitFuseParams) -> Result<()> {
    let count = p.step_count as usize;
    let mut prev_threshold: Option<u16> = None;
    let mut prev_exposure: u64 = 0;
    for i in 0..count {
        let threshold = p.step_thresholds_bps[i];
        let exposure = p.step_exposures_usd[i];
        require!(threshold <= 10_000, FuseError::InvalidCurve);
        require!(exposure <= p.risk_cap_usd, FuseError::InvalidCurve);
        if let Some(prev) = prev_threshold {
            require!(threshold > prev, FuseError::InvalidCurve);
        }
        require!(exposure >= prev_exposure, FuseError::InvalidCurve);
        prev_threshold = Some(threshold);
        prev_exposure = exposure;
    }
    Ok(())
}

fn raw_target(f: &FuseAccount, p_bps: u16) -> u64 {
    let mut target: u64 = 0;
    for i in 0..(f.step_count as usize) {
        if p_bps >= f.step_thresholds_bps[i] {
            target = f.step_exposures_usd[i];
        } else {
            break;
        }
    }
    target.min(f.risk_cap_usd)
}

fn exposure_step_index(f: &FuseAccount, exposure: u64) -> Option<usize> {
    for i in 0..(f.step_count as usize) {
        if f.step_exposures_usd[i] == exposure {
            return Some(i);
        }
    }
    None
}

fn probability_step_index(f: &FuseAccount, p_bps: u16) -> Option<usize> {
    let mut idx: Option<usize> = None;
    for i in 0..(f.step_count as usize) {
        if p_bps >= f.step_thresholds_bps[i] {
            idx = Some(i);
        } else {
            break;
        }
    }
    idx
}

fn expected_target_with_hysteresis(f: &FuseAccount, p_bps: u16) -> u64 {
    if p_bps < f.kill_probability_bps {
        return 0;
    }

    let raw = raw_target(f, p_bps);
    let current_abs = f.desired_exposure_usd.unsigned_abs();
    let current_idx = exposure_step_index(f, current_abs);
    let desired_idx = probability_step_index(f, p_bps);
    if current_idx.is_none() || desired_idx.is_none() {
        return raw;
    }

    let c = current_idx.unwrap();
    let d = desired_idx.unwrap();
    if d > c {
        let next_threshold = f.step_thresholds_bps[c + 1];
        if p_bps < next_threshold.saturating_add(f.hysteresis_bps) {
            return current_abs;
        }
    } else if d < c {
        let current_threshold = f.step_thresholds_bps[c];
        if p_bps >= current_threshold.saturating_sub(f.hysteresis_bps) {
            return current_abs;
        }
    }
    raw
}

fn is_risk_reducing(current: i64, next: i64) -> bool {
    if next == 0 { return true; }
    if current == 0 { return false; }
    next.signum() == current.signum() && next.unsigned_abs() <= current.unsigned_abs()
}

fn is_safe_relative_to_expected(expected: i64, submitted: i64) -> bool {
    if submitted == 0 { return true; }
    if expected == 0 { return false; }
    submitted.signum() == expected.signum() && submitted.unsigned_abs() <= expected.unsigned_abs()
}

fn kill_state(f: &mut Account<FuseAccount>, reason_code: u8) -> Result<()> {
    f.status = FuseStatus::Killed;
    f.desired_exposure_usd = 0;
    f.pending_target_exposure_usd = 0;
    f.last_reason_code = reason_code;
    emit!(FuseKilled { fuse: f.key(), reason_code, last_probability_bps: f.last_probability_bps });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitFuseParams {
    pub agent: Pubkey,
    pub execution_authority: Pubkey,
    pub oracle_authority: Pubkey,
    pub event_market: [u8; 32],
    pub outcome_id: [u8; 16],
    pub oracle_kind: u8,
    pub curve_hash: [u8; 32],
    pub curve_version: u16,
    pub step_count: u8,
    pub step_thresholds_bps: [u16; MAX_CURVE_STEPS],
    pub step_exposures_usd: [u64; MAX_CURVE_STEPS],
    pub risk_cap_usd: u64,
    pub max_leverage_bps: u32,
    pub kill_probability_bps: u16,
    pub hysteresis_bps: u16,
    pub max_oracle_age_sec: u32,
    pub loss_stop_usd: u64,
    pub expiry_ts: i64,
    pub venue: u8,
    pub market_id: [u8; 32],
}

#[derive(Accounts)]
#[instruction(fuse_id: u64)]
pub struct InitFuse<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + FuseAccount::INIT_SPACE,
        seeds = [b"fuse", owner.key().as_ref(), &fuse_id.to_le_bytes()],
        bump
    )]
    pub fuse: Account<'info, FuseAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerFuse<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub fuse: Account<'info, FuseAccount>,
}

#[derive(Accounts)]
pub struct OracleFuse<'info> {
    pub oracle_authority: Signer<'info>,
    #[account(mut, has_one = oracle_authority)]
    pub fuse: Account<'info, FuseAccount>,
}

#[derive(Accounts)]
pub struct ExecutionFuse<'info> {
    pub execution_authority: Signer<'info>,
    #[account(mut, has_one = execution_authority)]
    pub fuse: Account<'info, FuseAccount>,
}

#[account]
#[derive(InitSpace)]
pub struct FuseAccount {
    pub fuse_id: u64,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub execution_authority: Pubkey,
    pub oracle_authority: Pubkey,
    pub event_market: [u8; 32],
    pub outcome_id: [u8; 16],
    pub oracle_kind: u8,
    pub curve_hash: [u8; 32],
    pub curve_version: u16,
    pub step_count: u8,
    pub step_thresholds_bps: [u16; MAX_CURVE_STEPS],
    pub step_exposures_usd: [u64; MAX_CURVE_STEPS],
    pub risk_cap_usd: u64,
    pub max_leverage_bps: u32,
    pub kill_probability_bps: u16,
    pub hysteresis_bps: u16,
    pub max_oracle_age_sec: u32,
    pub loss_stop_usd: u64,
    pub expiry_ts: i64,
    pub venue: u8,
    pub market_id: [u8; 32],
    pub position_ref: [u8; 32],
    pub status: FuseStatus,
    pub desired_exposure_usd: i64,
    pub filled_exposure_usd: i64,
    pub last_probability_bps: u16,
    pub last_mark_price: u64,
    pub oracle_sequence: u64,
    pub execution_nonce: u64,
    pub pending_execution_nonce: u64,
    pub pending_target_exposure_usd: i64,
    pub last_update_slot: u64,
    pub last_receipt_hash: [u8; 32],
    pub last_reason_code: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum FuseStatus { Proposed, Armed, Open, Reducing, Killed, Settled }

#[repr(u8)]
pub enum ReasonCode {
    InitialOpen = 1,
    ProbabilityStepUp = 2,
    ProbabilityStepDown = 3,
    RiskCapClamp = 4,
    KillProbability = 5,
    LossStop = 6,
    ExpiryClose = 7,
    OwnerCancel = 8,
    Settlement = 9,
    Noop = 10,
    EmergencyKill = 11,
}

#[event]
pub struct FuseInitialized { pub fuse: Pubkey, pub owner: Pubkey, pub curve_hash: [u8; 32], pub risk_cap_usd: u64 }
#[event]
pub struct FuseArmed { pub fuse: Pubkey }
#[event]
pub struct ObservationAccepted { pub fuse: Pubkey, pub p_bps: u16, pub mark_price: u64, pub oracle_sequence: u64 }
#[event]
pub struct PolicyTargetVerified { pub fuse: Pubkey, pub probability_bps: u16, pub expected_target_usd: i64, pub submitted_target_usd: i64, pub reason_code: u8 }
#[event]
pub struct TargetSet { pub fuse: Pubkey, pub target_exposure_usd: i64, pub execution_nonce: u64, pub reason_code: u8 }
#[event]
pub struct FillRecorded { pub fuse: Pubkey, pub filled_exposure_usd: i64, pub execution_nonce: u64, pub receipt_hash: [u8; 32], pub reason_code: u8 }
#[event]
pub struct FuseKilled { pub fuse: Pubkey, pub reason_code: u8, pub last_probability_bps: u16 }
#[event]
pub struct FuseSettled { pub fuse: Pubkey }

#[error_code]
pub enum FuseError {
    #[msg("invalid state transition")] InvalidState,
    #[msg("risk cap must be positive")] InvalidRiskCap,
    #[msg("target exceeds hard risk cap")] RiskCapExceeded,
    #[msg("probability must be <= 10000 bps")] InvalidProbability,
    #[msg("oracle age configuration invalid")] InvalidOracleAge,
    #[msg("fuse has already expired")] AlreadyExpired,
    #[msg("oracle observation is stale")] StaleOracle,
    #[msg("observation timestamp is in the future")] FutureObservation,
    #[msg("replayed sequence or nonce")] Replay,
    #[msg("killed fuse can only reduce/close")] KilledCanOnlyClose,
    #[msg("expired fuse can only reduce/close")] ExpiredCanOnlyReduce,
    #[msg("kill condition not met")] KillConditionNotMet,
    #[msg("execution nonce does not match pending execution")] ExecutionNonceMismatch,
    #[msg("position exposure must be zero")] NonZeroExposure,
    #[msg("invalid committed curve")] InvalidCurve,
    #[msg("submitted target does not match the committed onchain policy")] PolicyExecutionMismatch,
    #[msg("submitted target increases risk beyond the committed policy")] UnsafeRiskIncrease,
}

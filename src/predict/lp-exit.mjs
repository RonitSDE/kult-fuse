// Resumable liquidity exit for PREDICT pm-AMM markets.
//
// The exit is several transactions. Any of them can fail after an earlier one landed (wallet
// closed, RPC blip, SOL ran out), so the executor re-reads chain state before every step and asks
// this planner for the next one. Running the exit again after a failure resumes where it stopped.
//
// Program rules this follows (pm_amm/src/instructions):
// - claim_committer: vault launched, position not claimed; creates the committer's LpPosition.
// - withdraw_liquidity: rejected after resolution.
// - redeem_pair: burns 1 YES + 1 NO for 1 mUSDC.
// - claim_lp_residuals: mints pending YES+NO; fails with NoResidualsToClaim when nothing is due.
// - claim_winnings: market resolved (winning_side 1 = YES, 2 = NO); pays the winning balance.

/**
 * @param {object} s chain state
 * @param {boolean} s.resolved
 * @param {number} s.winningSide 1 YES, 2 NO, anything else = no payable side
 * @param {boolean} s.commitClaimable a launched-vault commitment not yet turned into LP shares
 * @param {boolean} s.hasLp an LpPosition account exists
 * @param {bigint|number} s.lpShares
 * @param {number} s.yes raw YES balance
 * @param {number} s.no raw NO balance
 * @param {Set<string>} attempted steps already tried in this run
 * @returns {{step:string, amountRaw?:number}|null}
 */
export function nextLpExitStep(s, attempted = new Set()) {
  if (s.commitClaimable && !attempted.has('claimCommitter')) return { step: 'claimCommitter' };
  if (!s.resolved) {
    if (BigInt(s.lpShares || 0) > 0n && !attempted.has('withdrawLiquidity')) return { step: 'withdrawLiquidity' };
    const pairs = Math.min(s.yes || 0, s.no || 0);
    if (pairs > 0 && !attempted.has('redeemPair')) return { step: 'redeemPair', amountRaw: pairs };
    return null;
  }
  if (s.hasLp && !attempted.has('claimLpResiduals')) return { step: 'claimLpResiduals' };
  const winning = s.winningSide === 1 ? s.yes : s.winningSide === 2 ? s.no : 0;
  if (winning > 0 && !attempted.has('claimWinnings')) return { step: 'claimWinnings' };
  return null;
}

/** True when an LP exit still has work to do, for showing a resume button. */
export function lpExitPending(s) { return nextLpExitStep(s) !== null; }

export const LP_EXIT_JOURNAL_KIND = {
  claimCommitter: 'LP_ALLOCATION_CLAIM', withdrawLiquidity: 'LP_WITHDRAW', redeemPair: 'REDEEM_PAIRS',
  claimLpResiduals: 'LP_CLAIM', claimWinnings: 'CLAIM'
};

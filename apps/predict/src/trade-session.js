const sessionKey = wallet => `kult-fuse-trade-session-v3:${wallet}`;
const hour = 60 * 60 * 1000;

export function loadTradeSession(wallet) {
  if (!wallet) return null;
  const stored = localStorage.getItem(sessionKey(wallet));
  return stored ? JSON.parse(stored) : null;
}

export function saveTradeSession(session) {
  localStorage.setItem(sessionKey(session.wallet), JSON.stringify(session));
}

export function startTradeSession(wallet, marketPda, { maxSingle, maxTotal, maxSlippageBps }) {
  if (!wallet || !marketPda) throw new Error('Start a test wallet and choose a market');
  if (!Number.isFinite(maxSingle) || !Number.isFinite(maxTotal) || maxSingle < 0.1 ||
      maxSingle > 100 || maxTotal < maxSingle || maxTotal > 1000 ||
      !Number.isInteger(maxSlippageBps) || maxSlippageBps < 10 || maxSlippageBps > 300) {
    throw new Error('Use 0.1–100 mUSDC per trade, a session cap up to 1,000 and 10–300 bps slippage');
  }
  const current = loadTradeSession(wallet);
  if (current?.expiresAtMs > Date.now()) throw new Error('Current limits stay in place until this session expires');
  const prior = JSON.parse(localStorage.getItem('kult-fuse-predict-session-v1') || 'null');
  const migrated = !current && prior?.wallet === wallet && prior.startedAt + hour > Date.now();
  const session = {
    wallet, marketPda, side: 'either', maxSingle, maxTotal, maxSlippageBps,
    spent: migrated && Number.isFinite(prior.spent) ? Math.max(0, prior.spent) : 0,
    killed: Boolean(migrated && prior.killed),
    expiresAtMs: migrated ? prior.startedAt + hour : Date.now() + hour
  };
  saveTradeSession(session);
  return session;
}

export function withTradeLock(wallet, action) {
  if (!navigator.locks) throw new Error('Trading requires a secure browser with tab locking');
  return navigator.locks.request(sessionKey(wallet), { ifAvailable: true }, lock => {
    if (!lock) throw new Error('A trade is already being prepared in another tab');
    return action();
  });
}

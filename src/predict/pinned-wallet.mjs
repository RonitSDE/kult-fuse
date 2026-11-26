// Pin a multi-step flow to one wallet.
//
// Extensions can switch accounts at any moment (Phantom emits `accountChanged`). A flow that signs
// several transactions must read state for, and sign with, the same address throughout, and stop
// the moment the active account differs, including while a signing popup is open.

export class WalletChangedError extends Error {
  constructor() {
    super('Active wallet changed during this flow. Nothing more was sent; switch back and click again to resume.');
    this.name = 'WalletChangedError';
  }
}

const keyOf = (k) => (k == null ? null : typeof k === 'string' ? k : k.toBase58());

/** Throw unless the currently active wallet is `owner`. */
export function assertActiveWallet(owner, getActive) {
  if (keyOf(getActive()?.publicKey) !== keyOf(owner)) throw new WalletChangedError();
}

/**
 * Wrap a wallet so its address is frozen and every signature is checked against the active
 * account before the popup opens and again after it returns.
 */
export function pinWallet(wallet, getActive) {
  const owner = wallet.publicKey;
  const check = () => assertActiveWallet(owner, getActive);
  return {
    ...wallet,
    publicKey: owner,
    async signTransaction(tx) { check(); const signed = await wallet.signTransaction(tx); check(); return signed; },
    async signAllTransactions(txs) { check(); const signed = await wallet.signAllTransactions(txs); check(); return signed; },
    assertActive: check
  };
}

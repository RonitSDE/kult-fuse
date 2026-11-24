import { Keypair } from '@solana/web3.js';

// Two kinds of signer share one interface ({ kind, label, publicKey, signTransaction, signAllTransactions }),
// which is also what AnchorProvider expects, so every PREDICT action works with either:
//  - "burner": a Devnet test keypair kept in this browser (v2.1.1 behaviour, unchanged storage keys).
//  - "external": a browser wallet extension (Phantom, Solflare, Backpack) via its injected provider.
//    The private key never leaves the extension; each transaction is approved in the wallet popup.
// Transactions are always sent through this app's Devnet connection, never the wallet's own RPC.
const key = 'kult-fuse-predict-devnet-v1';            // same key v2.0.x used: earlier wallets come back
const tabKey = 'kult-fuse-devnet-tab-wallet';          // v2.1.0 tab-only wallet, migrated if still open
const externalKey = 'kult-fuse-predict-external-wallet'; // remembered extension id for silent reconnect
let burner = null;
let external = null;   // { id, label, provider, publicKey }
const listeners = new Set();

function store(fn) { try { return fn(); } catch { return null; } }
function decode(raw) {
  try {
    const bytes = JSON.parse(raw);
    return Array.isArray(bytes) && bytes.length === 64 ? Keypair.fromSecretKey(Uint8Array.from(bytes)) : null;
  } catch { return null; }
}
function emit() { for (const fn of listeners) { try { fn(getWallet()); } catch {} } }
export function onWalletChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function loadBurner() {
  if (burner) return burner;
  burner = decode(store(() => localStorage.getItem(key)));
  if (!burner) {
    const fromTab = decode(store(() => sessionStorage.getItem(tabKey)));
    if (fromTab) {
      store(() => localStorage.setItem(key, JSON.stringify(Array.from(fromTab.secretKey))));
      store(() => sessionStorage.removeItem(tabKey));
      burner = fromTab;
    }
  }
  return burner;
}

function burnerSigner(kp) {
  return {
    kind: 'burner', label: 'Test wallet', publicKey: kp.publicKey,
    async signTransaction(tx) { tx.partialSign(kp); return tx; },
    async signAllTransactions(txs) { for (const tx of txs) tx.partialSign(kp); return txs; }
  };
}

function externalSigner(w) {
  return {
    kind: 'external', label: w.label, id: w.id, publicKey: w.publicKey,
    signTransaction: tx => w.provider.signTransaction(tx),
    signAllTransactions: txs => w.provider.signAllTransactions
      ? w.provider.signAllTransactions(txs)
      : Promise.all(txs.map(tx => w.provider.signTransaction(tx)))
  };
}

/** The active signer: a connected extension wins over the saved test wallet. */
export function getWallet() {
  if (external) return externalSigner(external);
  const kp = loadBurner();
  return kp ? burnerSigner(kp) : null;
}

// Kept for the UI's restore button; persistence makes a separate restore step unnecessary.
export function hasLegacyWallet() { return false; }

export function ensureWallet() {
  const current = getWallet();
  if (current) return current;
  burner = Keypair.generate();
  store(() => localStorage.setItem(key, JSON.stringify(Array.from(burner.secretKey))));
  emit();
  return getWallet();
}

// ---------- browser wallet extensions ----------
const KNOWN = [
  { id: 'phantom',  label: 'Phantom',  get: () => window.phantom?.solana?.isPhantom ? window.phantom.solana : (window.solana?.isPhantom ? window.solana : null), url: 'https://phantom.com/download' },
  { id: 'solflare', label: 'Solflare', get: () => window.solflare?.isSolflare ? window.solflare : null, url: 'https://solflare.com/download' },
  { id: 'backpack', label: 'Backpack', get: () => window.backpack?.isBackpack ? window.backpack : null, url: 'https://backpack.app/downloads' }
];

/** Every supported wallet, with whether its extension is installed in this browser. */
export function availableWallets() {
  return KNOWN.map(w => ({ id: w.id, label: w.label, url: w.url, installed: Boolean(store(w.get)) }));
}

function attach(entry, provider, publicKey) {
  if (!publicKey) throw new Error(`${entry.label} did not share an address`);
  external = { id: entry.id, label: entry.label, provider, publicKey };
  store(() => localStorage.setItem(externalKey, entry.id));
  provider.on?.('accountChanged', next => {
    if (!external || external.provider !== provider) return;
    if (next) { external.publicKey = next; emit(); } else disconnectWallet();
  });
  provider.on?.('disconnect', () => { if (external?.provider === provider) { external = null; store(() => localStorage.removeItem(externalKey)); emit(); } });
  emit();
  return getWallet();
}

/** Opens the extension's approval popup. Throws a readable error if it isn't installed or is rejected. */
export async function connectWallet(id) {
  const entry = KNOWN.find(w => w.id === id);
  if (!entry) throw new Error('Unsupported wallet');
  const provider = store(entry.get);
  if (!provider) { window.open(entry.url, '_blank', 'noopener'); throw new Error(`${entry.label} is not installed in this browser`); }
  try {
    const res = await provider.connect();
    return attach(entry, provider, res?.publicKey || provider.publicKey);
  } catch (e) {
    if (e?.code === 4001 || /reject|denied|cancel/i.test(e?.message || '')) throw new Error(`${entry.label} connection was cancelled`);
    throw e;
  }
}

/** Reconnects a previously approved extension without a popup. Silent no-op otherwise. */
export async function restoreWallet() {
  const id = store(() => localStorage.getItem(externalKey));
  const entry = KNOWN.find(w => w.id === id);
  const provider = entry && store(entry.get);
  if (!provider) return null;
  try {
    const res = await provider.connect({ onlyIfTrusted: true });
    return attach(entry, provider, res?.publicKey || provider.publicKey);
  } catch { return null; }
}

/** Disconnects the extension; the saved test wallet (if any) becomes active again. */
export async function disconnectWallet() {
  const w = external;
  external = null;
  store(() => localStorage.removeItem(externalKey));
  try { await w?.provider.disconnect?.(); } catch {}
  emit();
}

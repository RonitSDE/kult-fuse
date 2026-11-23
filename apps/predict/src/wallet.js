import { Keypair } from '@solana/web3.js';

// v2.1.1: the Devnet test wallet persists in this browser (localStorage), so a trader can close
// the tab and come back to sell, follow resolution and claim winnings. One wallet per person also
// keeps "unique wallets" and "repeat traders" honest. Test funds only; never import a real key.
const key = 'kult-fuse-predict-devnet-v1';            // same key v2.0.x used: earlier wallets come back
const tabKey = 'kult-fuse-devnet-tab-wallet';          // v2.1.0 tab-only wallet, migrated if still open
let wallet = null;

function decode(raw) {
  try {
    const bytes = JSON.parse(raw);
    return Array.isArray(bytes) && bytes.length === 64 ? Keypair.fromSecretKey(Uint8Array.from(bytes)) : null;
  } catch { return null; }
}

export function getWallet() {
  if (wallet) return wallet;
  wallet = decode(localStorage.getItem(key));
  if (!wallet) {
    const fromTab = decode(sessionStorage.getItem(tabKey));
    if (fromTab) {
      localStorage.setItem(key, JSON.stringify(Array.from(fromTab.secretKey)));
      sessionStorage.removeItem(tabKey);
      wallet = fromTab;
    }
  }
  return wallet;
}

// Kept for the UI's restore button; persistence makes a separate restore step unnecessary.
export function hasLegacyWallet() { return false; }

export function ensureWallet() {
  if (getWallet()) return wallet;
  wallet = Keypair.generate();
  localStorage.setItem(key, JSON.stringify(Array.from(wallet.secretKey)));
  return wallet;
}

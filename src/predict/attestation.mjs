import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decodeBase58 } from './proof.mjs';

const PREFIX = 'kult-fuse:predict:v3';
const TTL_SECONDS = 120;
export function isBase58(value, bytes) {
  return typeof value === 'string' && value.length <= Math.ceil(bytes * 1.37) &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(value) && decodeBase58(value).length === bytes;
}

// A trade is a buy (USDC → YES/NO; amountRaw is mUSDC spent) or, since v2.1.3, a sell
// (YES/NO → USDC; amountRaw is outcome tokens sold). `action` is left out of buy intents so the
// attestation for a buy is byte-identical to v2.1.x.
export function normalizeTradeIntent(body) {
  const { wallet, marketPda, blockhash, side, amountRaw, minOutRaw } = body ?? {};
  const action = body?.action ?? 'buy';
  const maxAmount = action === 'sell' ? 100_000_000_000 : 100_000_000;
  if (![wallet, marketPda, blockhash].every(key => isBase58(key, 32)) ||
      !['yes', 'no'].includes(side) || !['buy', 'sell'].includes(action) ||
      !Number.isSafeInteger(amountRaw) || amountRaw < 100_000 || amountRaw > maxAmount ||
      !Number.isSafeInteger(minOutRaw) || minOutRaw < 1) {
    throw new Error('Invalid trade review');
  }
  return action === 'sell'
    ? { wallet, marketPda, blockhash, side, amountRaw, minOutRaw, action }
    : { wallet, marketPda, blockhash, side, amountRaw, minOutRaw };
}

export function createTradeAttestation(secret, clock = () => Math.floor(Date.now() / 1000)) {
  if (!/^[a-f0-9]{64}$/i.test(secret ?? '')) throw new Error('Set PREDICT_ATTESTATION_KEY to 32 random bytes encoded as hex');
  const key = Buffer.from(secret, 'hex');
  function mac(intent, issuedAt, nonce) {
    return createHmac('sha256', key).update(JSON.stringify([PREFIX, issuedAt, nonce, normalizeTradeIntent(intent)]))
      .digest().subarray(0, 16);
  }
  return {
    issue(intent) {
      const issuedAt = clock();
      const nonce = randomBytes(12).toString('base64url');
      return `${PREFIX}:${issuedAt}:${nonce}:${mac(intent, issuedAt, nonce).toString('base64url')}`;
    },
    verify(memo, intent, blockTime) {
      const match = /^kult-fuse:predict:v3:(\d{10}):([\w-]{16}):([\w-]{22})$/.exec(memo);
      if (!match || !Number.isSafeInteger(blockTime)) return false;
      const issuedAt = Number(match[1]);
      const [, , nonce, encodedMac] = match;
      if (blockTime < issuedAt - 20 || blockTime > issuedAt + TTL_SECONDS) return false;
      try {
        return timingSafeEqual(mac(intent, issuedAt, nonce), Buffer.from(encodedMac, 'base64url'));
      } catch {
        return false;
      }
    }
  };
}

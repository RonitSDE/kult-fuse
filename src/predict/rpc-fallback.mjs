// RPC failover shared by the server and the browser bundle (no Node-only imports).
// web3.js lets a Connection take a custom `fetch`; this one sends each JSON-RPC request to the
// primary URL and, on a network error, timeout, 429 or 5xx, replays the same body on the next URL.
// The Connection itself is created with the primary URL, so callers keep a single connection.

export const PUBLIC_DEVNET_RPC = 'https://api.devnet.solana.com';

/** Unique, non-empty HTTPS URLs in order. Rejects mainnet so a typo can never reach real funds. */
export function rpcList(...urls) {
  const out = [];
  for (const raw of urls) {
    const value = String(raw || '').trim();
    if (!value || out.includes(value)) continue;
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Use HTTPS Devnet RPC URLs');
    if (/mainnet/i.test(value)) throw new Error('Mainnet RPC is not allowed');
    out.push(value);
  }
  return out;
}

const retryable = status => status === 429 || status >= 500;

export function fallbackFetch(urls, { timeoutMs = 9000, fetchImpl = (...a) => fetch(...a), onFallback } = {}) {
  if (!urls.length) throw new Error('At least one RPC URL is required');
  return async (_url, options = {}) => {
    let lastError;
    let lastResponse;
    for (let i = 0; i < urls.length; i++) {
      try {
        const response = await fetchImpl(urls[i], { ...options, signal: AbortSignal.timeout(timeoutMs) });
        if (!retryable(response.status) || i === urls.length - 1) return response;
        lastResponse = response;
      } catch (error) {
        lastError = error;
        if (i === urls.length - 1) throw error;
      }
      onFallback?.(urls[i], urls[i + 1]);
    }
    if (lastResponse) return lastResponse;
    throw lastError;
  };
}

/** Options for `new Connection(urls[0], ...)`. Subscriptions use the primary's websocket. */
export function connectionConfig(urls, { commitment = 'confirmed', timeoutMs, wsEndpoint, retryRateLimitWhenSingle = false } = {}) {
  return {
    commitment,
    disableRetryOnRateLimit: urls.length > 1 || !retryRateLimitWhenSingle,
    fetch: fallbackFetch(urls, { timeoutMs }),
    ...(wsEndpoint ? { wsEndpoint } : {})
  };
}

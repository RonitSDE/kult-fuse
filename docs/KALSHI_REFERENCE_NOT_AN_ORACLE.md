# Kalshi market data source and trust boundary

The trading strategy remains: DFlow YES outcome bid/ask + source sequence → graded probability → Fuse mandate → Velocity SOL-PERP. The Kalshi public API is a read-only **research/diagnostic aid** for the exact DFlow ticker. It is deliberately not consulted inside `src/worker/fuse-engine.mjs` or used to sign and submit market orders.

Official Kalshi REST base URLs: production `https://external-api.kalshi.com/trade-api/v2`, demo `https://external-api.demo.kalshi.co/trade-api/v2`. We only GET `markets/{ticker}` and `markets/{ticker}/orderbook`. Book is fixed-point `orderbook_fp.yes_dollars` and `.no_dollars`, each entry `[price_string, quantity_string]`. NO best bid is the complement of the YES ask. Empty/crossed book is unavailable, never a fabricated probability. DFlow and Kalshi could be delayed, on different liquidity surfaces or diverge. A similar price does not prove oracle correctness, suitability of a trade or a Solana transaction.

The observer has static hosts, selected market ticker validation, no user-supplied URL, no credentials, no order path, 4-second timeout, 128KB response limit, 30-second cache and nonfatal fail-closed display fallback. A closed/settled market is not presented as corroboration.

Current limitation: the DFlow signal is worker-observed and the worker owns the Velocity signing key. This release does not cryptographically bind all venue orders to Fuse. Adding Kalshi REST does **not** address that security requirement.

Direct documentation: https://docs.kalshi.com/getting_started/quick_start_market_data.md and https://docs.kalshi.com/getting_started/orderbook_responses.md .

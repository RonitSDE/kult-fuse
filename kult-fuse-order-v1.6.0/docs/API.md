# HTTP API

Public GET /healthz: build identity and health. GET /api/state: quote, Fuse state, actual venue position, receipts, worker decisions and unbound-authority status. Public GET /api/decisions returns the current mandate's bounded worker decision journal as JSON; it is not execution proof. GET /api/proof: links and verified replay only when current receipts pass onchain verification. POST /api/verify: read-only independent verification from Solana RPC.

Operator POST /api/auth, /api/arm, /api/tick, /api/kill, /api/settle, /api/fuse/new require Authorization: Bearer FUSE_ADMIN_TOKEN. Do not expose owner or trading keys to a browser. On a loss of the persistent DATA_DIR, the server refuses a new mandate if the venue still has exposure.

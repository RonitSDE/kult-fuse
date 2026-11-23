// One global per-minute budget plus a cap on operations in flight. Do not trust X-Forwarded-For
// unless the ingress sanitizes it. This protects expensive RPC verification from both spoofed-IP
// rotation and concurrent floods. The default (one in flight) suits the costly public verifier;
// the PREDICT routes allow a few at once so simultaneous traders are not turned away.
export function createVerifyLimiter({ maxPerMinute = 6, maxConcurrent = 1, windowMs = 60000, clock = Date.now } = {}) {
  let windowStart = clock();
  let requests = 0;
  let active = 0;
  return {
    acquire() {
      const now = clock();
      if (now - windowStart >= windowMs) { windowStart = now; requests = 0; }
      if (active >= maxConcurrent || requests >= maxPerMinute) return false;
      active += 1;
      requests += 1;
      return true;
    },
    release() { active = Math.max(0, active - 1); }
  };
}

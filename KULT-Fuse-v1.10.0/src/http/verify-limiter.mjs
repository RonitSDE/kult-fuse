// One global budget and one in-flight operation. Do not trust X-Forwarded-For
// unless the deployment ingress sanitizes it. This protects expensive RPC
// verification from both spoofed-IP rotation and concurrent request floods.
export function createVerifyLimiter({ maxPerMinute = 6, windowMs = 60000, clock = Date.now } = {}) {
  let windowStart = clock();
  let requests = 0;
  let active = false;
  return {
    acquire() {
      const now = clock();
      if (now - windowStart >= windowMs) { windowStart = now; requests = 0; }
      if (active || requests >= maxPerMinute) return false;
      active = true;
      requests += 1;
      return true;
    },
    release() { active = false; }
  };
}

// Soft, KV-backed per-IP brute-force throttle for the password-gated /authorize
// POST. KV is eventually consistent, so this raises the cost of credential
// guessing rather than enforcing a hard limit — a Cloudflare WAF rate-limiting
// rule on /authorize is the recommended production-grade layer on top of this.

const PREFIX = "authfail:";
/** Failures allowed within the window before /authorize starts returning 429. */
export const MAX_FAILURES = 10;
/** Sliding window (seconds). KV's minimum expirationTtl is 60s; we use 15 min. */
export const WINDOW_TTL = 900;

function key(ip: string): string {
  return PREFIX + ip;
}

/** True once the IP has accumulated MAX_FAILURES failures within the window. */
export async function isRateLimited(kv: KVNamespace, ip: string): Promise<boolean> {
  if (!ip) return false; // No client IP (e.g. local/test) — don't throttle.
  const raw = await kv.get(key(ip));
  const count = raw ? Number.parseInt(raw, 10) : 0;
  return count >= MAX_FAILURES;
}

/** Increment the failure counter and (re)arm the sliding-window TTL. */
export async function recordAuthFailure(kv: KVNamespace, ip: string): Promise<void> {
  if (!ip) return;
  const raw = await kv.get(key(ip));
  const count = (raw ? Number.parseInt(raw, 10) : 0) + 1;
  await kv.put(key(ip), String(count), { expirationTtl: WINDOW_TTL });
}

/** Reset the counter after a successful authorization. */
export async function clearAuthFailures(kv: KVNamespace, ip: string): Promise<void> {
  if (!ip) return;
  await kv.delete(key(ip));
}

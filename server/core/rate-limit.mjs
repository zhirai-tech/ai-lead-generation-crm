/**
 * In-memory sliding-window rate limiting.
 *
 * Works for a single-node self-hosted deployment (the supported topology).
 * If the platform is later scaled horizontally this must move to a shared
 * store; that limitation is documented in docs/SECURITY.md.
 */
const buckets = new Map();
let sweeper = null;

function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
      else if (bucket.hits.length === 0 && bucket.resetAt < now) buckets.delete(key);
    }
    if (buckets.size === 0) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, 60_000);
  if (typeof sweeper.unref === 'function') sweeper.unref();
}

/**
 * @param {string} key unique bucket key (e.g. `login:1.2.3.4`)
 * @param {{windowMs:number,max:number}} options
 * @returns {{allowed:boolean,remaining:number,retryAfterMs:number}}
 */
export function consume(key, { windowMs = 60_000, max = 60 } = {}) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { hits: [], resetAt: now + windowMs };
    buckets.set(key, bucket);
    ensureSweeper();
  }
  bucket.hits = bucket.hits.filter((time) => now - time < windowMs);
  if (bucket.hits.length >= max) {
    const oldest = bucket.hits[0] || now;
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(1000, windowMs - (now - oldest)) };
  }
  bucket.hits.push(now);
  return { allowed: true, remaining: Math.max(0, max - bucket.hits.length), retryAfterMs: 0 };
}

export function resetAll() {
  buckets.clear();
}

export default { consume, resetAll };

import { config } from "./config.js";

export function createRateLimiter({
  windowMs = config.limits.rateWindowMs,
  max = config.limits.rateMax,
  now = Date.now,
} = {}) {
  const buckets = new Map();
  let requests = 0;

  return function rateLimit(req, res, next) {
    const key = `${req.actor?.uid ?? "anonymous"}:${req.ip}`;
    const timestamp = now();
    requests += 1;
    if (requests % 1000 === 0) {
      for (const [bucketKey, value] of buckets) {
        if (timestamp - value.startedAt >= windowMs) buckets.delete(bucketKey);
      }
    }
    const bucket = buckets.get(key);
    if (!bucket || timestamp - bucket.startedAt >= windowMs) {
      buckets.set(key, { startedAt: timestamp, count: 1 });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.max(
        1,
        Math.ceil((windowMs - (timestamp - bucket.startedAt)) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ message: "Muitas solicitações. Tente novamente." });
      return;
    }
    next();
  };
}

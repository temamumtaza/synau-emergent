import type { NextFunction, Request, Response } from 'express';

type RateLimitOptions = {
  windowMs: number;
  max: number;
  name: string;
};

type Counter = {
  count: number;
  resetAt: number;
};

function clientKey(req: Request) {
  const userId = (req as Request & { userId?: string }).userId;
  if (userId) return `user:${userId}`;
  return `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
}

export function createRateLimiter(options: RateLimitOptions) {
  const counters = new Map<string, Counter>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = clientKey(req);
    const current = counters.get(key);
    const counter = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + options.windowMs }
      : current;
    counter.count += 1;
    counters.set(key, counter);

    if (counters.size > 10_000) {
      for (const [entryKey, entry] of counters) {
        if (entry.resetAt <= now) counters.delete(entryKey);
      }
    }

    const remaining = Math.max(0, options.max - counter.count);
    res.setHeader('RateLimit-Limit', String(options.max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(counter.resetAt / 1_000)));
    if (counter.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((counter.resetAt - now) / 1_000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Too many requests. Please try again shortly.',
        code: `${options.name}_rate_limited`,
      });
      return;
    }
    next();
  };
}

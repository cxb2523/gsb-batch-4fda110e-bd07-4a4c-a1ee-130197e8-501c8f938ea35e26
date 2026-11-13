export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export function createSlidingWindowRateLimiter(options: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}) {
  const { limit, windowMs, maxKeys = 10_000 } = options;
  const requestsByKey = new Map<string, number[]>();

  return function consume(key: string, now = Date.now()): RateLimitDecision {
    const recentRequests = (requestsByKey.get(key) ?? []).filter((timestamp) => timestamp > now - windowMs);
    const allowed = recentRequests.length < limit;
    const nextRequests = allowed ? [...recentRequests, now] : recentRequests;
    const resetAt = nextRequests.length > 0 ? nextRequests[0] + windowMs : now + windowMs;

    requestsByKey.delete(key);
    requestsByKey.set(key, nextRequests);

    if (requestsByKey.size > maxKeys) {
      const oldestKey = requestsByKey.keys().next().value as string | undefined;
      if (oldestKey !== undefined) requestsByKey.delete(oldestKey);
    }

    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - nextRequests.length),
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  };
}

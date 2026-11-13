import { describe, expect, it } from 'vitest';
import { createSlidingWindowRateLimiter } from './rateLimit';

describe('createSlidingWindowRateLimiter', () => {
  it('allows the configured number of requests and rejects the next one', () => {
    const consume = createSlidingWindowRateLimiter({ limit: 2, windowMs: 1_000 });

    expect(consume('client-a', 100).allowed).toBe(true);
    expect(consume('client-a', 200).remaining).toBe(0);
    const rejected = consume('client-a', 300);

    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSeconds).toBe(1);
  });

  it('expires requests as the rolling window advances and isolates clients', () => {
    const consume = createSlidingWindowRateLimiter({ limit: 1, windowMs: 1_000 });

    expect(consume('client-a', 100).allowed).toBe(true);
    expect(consume('client-b', 200).allowed).toBe(true);
    expect(consume('client-a', 1_101).allowed).toBe(true);
  });

  it('keeps the client map bounded', () => {
    const consume = createSlidingWindowRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 2 });

    consume('client-a', 100);
    consume('client-b', 100);
    consume('client-c', 100);

    expect(consume('client-a', 200).allowed).toBe(true);
  });
});

import { NextRequest, NextResponse } from 'next/server';
import { searchWikipedia } from '@/lib/wikipedia';
import { createSlidingWindowRateLimiter } from '@/lib/rateLimit';

const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const MAX_SEARCH_CACHE_ENTRIES = 500;
const MAX_PENDING_SEARCHES = 100;
const SEARCH_RATE_LIMIT = 120;
const SEARCH_RATE_WINDOW_MS = 10 * 60 * 1000;
const consumeSearchRateLimit = createSlidingWindowRateLimiter({
  limit: SEARCH_RATE_LIMIT,
  windowMs: SEARCH_RATE_WINDOW_MS,
});
const searchCache = new Map<string, { expiresAt: number; results: Awaited<ReturnType<typeof searchWikipedia>> }>();
const pendingSearches = new Map<string, Promise<Awaited<ReturnType<typeof searchWikipedia>>>>();

function setSearchCache(key: string, value: { expiresAt: number; results: Awaited<ReturnType<typeof searchWikipedia>> }): void {
  searchCache.delete(key);
  searchCache.set(key, value);

  while (searchCache.size > MAX_SEARCH_CACHE_ENTRIES) {
    const oldestKey = searchCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    searchCache.delete(oldestKey);
  }
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('q');

  if (!query || query.trim().length < 1) {
    return NextResponse.json([]);
  }

  const trimmedQuery = query.trim();
  const cacheKey = trimmedQuery.toLowerCase();
  let search: Promise<Awaited<ReturnType<typeof searchWikipedia>>> | undefined;
  const clientAddress = request.headers.get('x-real-ip')?.trim()
    || request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()
    || 'unknown';
  const rateLimit = consumeSearchRateLimit(clientAddress);
  const rateLimitHeaders = {
    'RateLimit-Limit': String(rateLimit.limit),
    'RateLimit-Remaining': String(rateLimit.remaining),
    'RateLimit-Reset': String(Math.ceil(rateLimit.resetAt / 1000)),
  };

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many search requests. Please wait before trying again.' },
      {
        status: 429,
        headers: { ...rateLimitHeaders, 'Retry-After': String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  try {
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      setSearchCache(cacheKey, cached);
      return NextResponse.json(cached.results, {
        headers: {
          ...rateLimitHeaders,
          'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
        },
      });
    }
    searchCache.delete(cacheKey);

    search = pendingSearches.get(cacheKey);
    if (!search) {
      if (pendingSearches.size >= MAX_PENDING_SEARCHES) {
        return NextResponse.json(
          { error: 'Wikipedia search is busy. Please try again shortly.' },
          { status: 503, headers: { 'Retry-After': '1', 'Cache-Control': 'no-store' } },
        );
      }

      search = searchWikipedia(trimmedQuery);
      pendingSearches.set(cacheKey, search);
    }

    const results = await search;
    setSearchCache(cacheKey, { expiresAt: Date.now() + SEARCH_CACHE_TTL, results });
    return NextResponse.json(results, {
      headers: {
        ...rateLimitHeaders,
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      },
    });
  } catch (error) {
    console.error('Search error:', error);
    return NextResponse.json(
      { error: 'Wikipedia search is temporarily unavailable' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  } finally {
    if (search && pendingSearches.get(cacheKey) === search) {
      pendingSearches.delete(cacheKey);
    }
  }
}

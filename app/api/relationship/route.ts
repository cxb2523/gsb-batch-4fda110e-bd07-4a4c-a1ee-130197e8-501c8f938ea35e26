import { NextRequest, NextResponse } from 'next/server';
import { getWikipediaRelationship } from '@/lib/wikipedia';
import { createSlidingWindowRateLimiter } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TITLE_LENGTH = 512;
const MAX_PENDING_RELATIONSHIPS = 100;
const RELATIONSHIP_RATE_LIMIT = 120;
const RELATIONSHIP_RATE_WINDOW_MS = 10 * 60 * 1000;
const consumeRelationshipRateLimit = createSlidingWindowRateLimiter({
  limit: RELATIONSHIP_RATE_LIMIT,
  windowMs: RELATIONSHIP_RATE_WINDOW_MS,
});
const pendingRelationships = new Map<string, ReturnType<typeof getWikipediaRelationship>>();

export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get('source')?.trim();
  const target = request.nextUrl.searchParams.get('target')?.trim();

  if (!source || !target) {
    return NextResponse.json({ error: 'source and target are required' }, { status: 400 });
  }
  if (source.length > MAX_TITLE_LENGTH || target.length > MAX_TITLE_LENGTH) {
    return NextResponse.json({ error: 'Relationship titles are too long' }, { status: 400 });
  }
  if (source.toLocaleLowerCase() === target.toLocaleLowerCase()) {
    return NextResponse.json({ error: 'A page cannot be related to itself' }, { status: 400 });
  }

  const clientAddress = request.headers.get('x-real-ip')?.trim()
    || request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()
    || 'unknown';
  const rateLimit = consumeRelationshipRateLimit(clientAddress);
  const rateLimitHeaders = {
    'RateLimit-Limit': String(rateLimit.limit),
    'RateLimit-Remaining': String(rateLimit.remaining),
    'RateLimit-Reset': String(Math.ceil(rateLimit.resetAt / 1000)),
  };

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many relationship requests. Please wait before trying again.' },
      {
        status: 429,
        headers: { ...rateLimitHeaders, 'Retry-After': String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  const key = `${source.replace(/_/g, ' ').toLocaleLowerCase()}\u0000${target.replace(/_/g, ' ').toLocaleLowerCase()}`;
  let relationship = pendingRelationships.get(key);
  if (!relationship) {
    if (pendingRelationships.size >= MAX_PENDING_RELATIONSHIPS) {
      return NextResponse.json(
        { error: 'Relationship analysis is busy. Please try again shortly.' },
        { status: 503, headers: { ...rateLimitHeaders, 'Retry-After': '1' } },
      );
    }
    relationship = getWikipediaRelationship(source, target);
    pendingRelationships.set(key, relationship);
  }

  try {
    const result = await relationship;
    return NextResponse.json(result, {
      headers: {
        ...rateLimitHeaders,
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    console.error('Relationship lookup error:', error);
    return NextResponse.json(
      { error: 'Could not load Wikipedia context for this connection' },
      { status: 502, headers: { ...rateLimitHeaders, 'Cache-Control': 'no-store' } },
    );
  } finally {
    if (pendingRelationships.get(key) === relationship) pendingRelationships.delete(key);
  }
}

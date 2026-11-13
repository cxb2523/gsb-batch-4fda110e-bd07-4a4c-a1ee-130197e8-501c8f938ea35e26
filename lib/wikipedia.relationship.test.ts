import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WikiRelationship } from '@/types/graph';

vi.mock('./db', () => ({
  getCachedPageLinks: vi.fn(() => null),
  getCachedPageViews: vi.fn(() => null),
  getCachedRelationship: vi.fn(() => null),
  setCachedPageLinks: vi.fn(),
  setCachedPageViews: vi.fn(),
  setCachedRelationship: vi.fn(),
}));

import { getWikipediaRelationship } from './wikipedia';
import * as database from './db';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('getWikipediaRelationship', () => {
  it('fetches source wikitext once, interprets its linked passage, and caches the result', async () => {
    const expected: WikiRelationship = {
      source: 'Albert Einstein',
      target: 'Theory of relativity',
      relation: 'developed',
      context: 'lead',
      explanation: 'WikiCrawl interprets the passage as: Albert Einstein developed Theory of relativity.',
      evidence: 'Albert Einstein developed the Theory of relativity.',
      section: 'Lead',
      sourceUrl: 'https://en.wikipedia.org/wiki/Albert_Einstein',
      sourceContextFound: true,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      expect(url.searchParams.get('action')).toBe('parse');
      expect(url.searchParams.get('prop')).toBe('wikitext');
      return new Response(JSON.stringify({
        parse: { wikitext: "'''Albert Einstein''' developed the [[Theory of relativity]]." },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await getWikipediaRelationship('Albert Einstein', 'Theory of relativity');

    expect(result).toEqual(expected);
    expect(database.setCachedRelationship).toHaveBeenCalledWith(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a missing source-text response instead of caching a fallback', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ parse: { title: 'Missing' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    await expect(getWikipediaRelationship('Missing', 'Target'))
      .rejects.toThrow('Wikipedia did not return source text');
    expect(database.setCachedRelationship).not.toHaveBeenCalled();
  });
});

import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WikiRelationship } from '@/types/graph';

vi.mock('@/lib/wikipedia', () => ({
  getWikipediaRelationship: vi.fn(),
}));

import { GET } from './route';
import { getWikipediaRelationship } from '@/lib/wikipedia';

afterEach(() => {
  vi.clearAllMocks();
});

describe('relationship route', () => {
  it('validates required and non-identical titles', async () => {
    const missing = await GET(new NextRequest('http://localhost/api/relationship?source=Albert%20Einstein'));
    const identical = await GET(new NextRequest(
      'http://localhost/api/relationship?source=Einstein&target=Einstein',
    ));

    expect(missing.status).toBe(400);
    expect(identical.status).toBe(400);
    expect(getWikipediaRelationship).not.toHaveBeenCalled();
  });

  it('returns on-demand Wikipedia relationship context', async () => {
    const expected: WikiRelationship = {
      source: 'Albert Einstein',
      target: 'Theory of relativity',
      relation: 'developed',
      context: 'lead',
      explanation: 'WikiCrawl interprets the passage as: Albert Einstein developed Theory of relativity.',
      evidence: 'Albert Einstein developed the theory of relativity.',
      section: 'Introduction',
      sourceUrl: 'https://en.wikipedia.org/wiki/Albert_Einstein',
      sourceContextFound: true,
    };
    vi.mocked(getWikipediaRelationship).mockResolvedValue(expected);

    const response = await GET(new NextRequest(
      'http://localhost/api/relationship?source=Albert%20Einstein&target=Theory%20of%20relativity',
      { headers: { 'x-real-ip': '192.0.2.190' } },
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(getWikipediaRelationship).toHaveBeenCalledWith('Albert Einstein', 'Theory of relativity');
  });
});

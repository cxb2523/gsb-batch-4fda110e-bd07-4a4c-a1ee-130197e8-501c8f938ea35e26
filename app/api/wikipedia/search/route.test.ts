import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/wikipedia', () => ({
  searchWikipedia: vi.fn(),
}));

import { GET } from './route';
import { searchWikipedia } from '@/lib/wikipedia';

afterEach(() => {
  vi.clearAllMocks();
});

describe('Wikipedia search route', () => {
  it('rejects new searches when the pending-search limit is reached', async () => {
    const resolveSearches: Array<(results: Array<{ title: string }>) => void> = [];
    vi.mocked(searchWikipedia).mockImplementation(() => new Promise((resolve) => {
      resolveSearches.push(resolve);
    }));

    const pendingResponses = Array.from({ length: 100 }, (_, index) =>
      GET(new NextRequest(`http://localhost/api/wikipedia/search?q=topic-${index}`)),
    );

    expect(searchWikipedia).toHaveBeenCalledTimes(100);

    const overflowResponse = await GET(
      new NextRequest('http://localhost/api/wikipedia/search?q=overflow'),
    );

    expect(overflowResponse.status).toBe(503);
    expect(overflowResponse.headers.get('Retry-After')).toBe('1');
    expect(searchWikipedia).toHaveBeenCalledTimes(100);

    for (const resolveSearch of resolveSearches) {
      resolveSearch([{ title: 'A result' }]);
    }
    await Promise.all(pendingResponses);
  });

  it('rate limits repeated searches from one client address', async () => {
    vi.mocked(searchWikipedia).mockResolvedValue([{ title: 'A result' }]);
    let response: Response | undefined;

    for (let index = 0; index <= 120; index += 1) {
      response = await GET(new NextRequest(
        `http://localhost/api/wikipedia/search?q=rate-limit-${index}`,
        { headers: { 'x-real-ip': '192.0.2.41' } },
      ));
      if (response.status === 429) break;
    }

    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBeTruthy();
    expect(response?.headers.get('RateLimit-Limit')).toBe('120');
    expect(searchWikipedia).toHaveBeenCalledTimes(120);
  });
});

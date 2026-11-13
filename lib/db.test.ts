import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CrawlResult, WikiRelationship } from '@/types/graph';

const originalPath = process.env.WIKICRAWL_DB_PATH;
const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

beforeAll(() => {
  process.env.WIKICRAWL_DB_PATH = '/definitely/missing/wikicrawl-cache/wiki-crawl.db';
});

afterAll(() => {
  if (originalPath === undefined) delete process.env.WIKICRAWL_DB_PATH;
  else process.env.WIKICRAWL_DB_PATH = originalPath;
  warningSpy.mockRestore();
});

describe('database cache fallback', () => {
  it('warns once and serves page links from memory after SQLite fails', async () => {
    const db = await import('./db');
    const page = { title: 'Memory page', resolvedTitle: 'Memory page', links: ['Next'], complete: true };
    const relationship: WikiRelationship = {
      source: 'Albert Einstein',
      target: 'Theory of relativity',
      relation: 'developed',
      context: 'lead',
      explanation: 'WikiCrawl interprets the passage as a development relationship.',
      evidence: 'Einstein developed the theory.',
      section: 'Work',
      sourceUrl: 'https://en.wikipedia.org/wiki/Albert_Einstein',
      sourceContextFound: true,
    };

    for (let index = 0; index < 50; index += 1) {
      expect(db.getCachedPageLinks(`missing-${index}`)).toBeNull();
      db.setCachedPageLinks({ ...page, title: `Memory page ${index}` });
    }
    db.setCachedRelationship(relationship);

    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(db.getCachedPageLinks('Memory page 49')).toEqual({ ...page, title: 'Memory page 49' });
    expect(db.getCachedRelationship('albert einstein', 'theory_of_relativity')).toEqual(relationship);
  });

  it('evicts the oldest page-link fallback entry at its bound', async () => {
    const db = await import('./db');
    for (let index = 0; index < 501; index += 1) {
      db.setCachedPageLinks({ title: `eviction-${index}`, resolvedTitle: `eviction-${index}`, links: [], complete: true });
    }

    expect(db.getCachedPageLinks('eviction-0')).toBeNull();
    expect(db.getCachedPageLinks('eviction-500')).not.toBeNull();
  });

  it('keeps crawl results in the bounded fallback cache', async () => {
    const db = await import('./db');
    const result = { id: 'memory', nodes: [], edges: [], communities: [], seedId: 'seed', crawledAt: '', positions: {} } satisfies CrawlResult;
    for (let index = 0; index < 21; index += 1) {
      db.setCachedResult(`result-${index}`, 'seed', 1, 50, { ...result, id: `result-${index}` });
    }

    expect(db.getCachedResult('result-0')).toBeNull();
    expect(db.getCachedResult('result-20')?.id).toBe('result-20');
  });
});
import { describe, expect, it } from 'vitest';
import { DENYLIST, isJunkTitle } from './filters';

describe('title filters', () => {
  it('rejects identifier titles and keeps year-only titles by default', () => {
    expect(isJunkTitle('Topic (identifier)')).toBe(true);
    expect(isJunkTitle('2019')).toBe(false);
    expect(isJunkTitle('2019', { rejectYearOnly: true })).toBe(true);
  });

  it('supports configurable denylist patterns', () => {
    DENYLIST.push(/^List of /i);
    try {
      expect(isJunkTitle('List of pages')).toBe(true);
    } finally {
      DENYLIST.pop();
    }
  });

  it('rejects only the explicitly configured non-topical hubs', () => {
    expect(isJunkTitle('Copyright')).toBe(true);
    expect(isJunkTitle('Copyright renewal in the United States')).toBe(true);
    expect(isJunkTitle('Wayback Machine')).toBe(true);
    expect(isJunkTitle('Wikidata')).toBe(true);
    expect(isJunkTitle('Copyright law')).toBe(false);
    expect(isJunkTitle('Wikimedia Commons')).toBe(false);
  });
});
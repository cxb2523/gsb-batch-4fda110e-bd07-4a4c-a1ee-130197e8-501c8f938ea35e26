import { describe, expect, it } from 'vitest';
import robots from './robots';
import { SITE_ORIGIN } from '@/lib/site';

describe('robots.txt', () => {
  it('allows public discovery pages and points to the configured sitemap', () => {
    const value = robots();
    expect(value.rules).toEqual({ userAgent: '*', allow: '/' });
    expect(value.sitemap).toBe(`${SITE_ORIGIN}/sitemap.xml`);
  });
});
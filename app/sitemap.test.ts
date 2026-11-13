import { describe, expect, it } from 'vitest';
import sitemap from './sitemap';
import { exploreTopics } from '@/lib/exploreTopics';
import { learnArticles } from '@/lib/learnArticles';
import { SITE_ORIGIN } from '@/lib/site';

describe('sitemap', () => {
  it('includes only the homepage and published explore and learn routes', () => {
    const urls = sitemap().map(({ url }) => url);
    expect(urls).toContain(`${SITE_ORIGIN}/`);
    expect(urls).toContain(`${SITE_ORIGIN}/explore`);
    expect(urls).toContain(`${SITE_ORIGIN}/learn`);
    for (const topic of exploreTopics) expect(urls).toContain(`${SITE_ORIGIN}/explore/${topic.slug}`);
    for (const article of learnArticles) expect(urls).toContain(`${SITE_ORIGIN}/learn/${article.slug}`);
    expect(urls.some((url) => url.includes('/api/'))).toBe(false);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
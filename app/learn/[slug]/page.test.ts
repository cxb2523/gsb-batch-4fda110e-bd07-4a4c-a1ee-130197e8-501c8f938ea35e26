import { describe, expect, it } from 'vitest';
import { generateMetadata, generateStaticParams } from './page';
import { learnArticles } from '@/lib/learnArticles';
import { exploreTopics } from '@/lib/exploreTopics';
import { SITE_ORIGIN } from '@/lib/site';

describe('learn article routes', () => {
  it('statically generates the published articles', () => {
    expect(generateStaticParams()).toEqual(learnArticles.map(({ slug }) => ({ slug })));
  });

  it('uses unique canonical metadata for each article', async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: 'what-is-a-wikipedia-rabbit-hole' }) });
    expect(metadata.alternates?.canonical).toBe('/learn/what-is-a-wikipedia-rabbit-hole');
    expect(metadata.openGraph?.url).toBe(`${SITE_ORIGIN}/learn/what-is-a-wikipedia-rabbit-hole`);
  });

  it('references only curated topic pages', () => {
    const topicSlugs = new Set(exploreTopics.map(({ slug }) => slug));
    for (const article of learnArticles) {
      expect(article.sections.length).toBeGreaterThan(0);
      expect(article.relatedTopics.every((slug) => topicSlugs.has(slug))).toBe(true);
    }
  });
});
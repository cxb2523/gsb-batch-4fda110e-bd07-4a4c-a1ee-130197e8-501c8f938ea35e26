import { describe, expect, it } from 'vitest';
import ExploreTopicPage, { generateMetadata, generateStaticParams } from './page';
import { exploreTopics } from '@/lib/exploreTopics';
import { SITE_ORIGIN } from '@/lib/site';

describe('explore topic routes', () => {
  it('statically generates every curated topic', () => {
    expect(generateStaticParams()).toEqual(exploreTopics.map(({ slug }) => ({ slug })));
  });

  it('returns topic-specific canonical and social metadata', async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: 'black-holes' }) });
    expect(metadata.alternates?.canonical).toBe('/explore/black-holes');
    expect(metadata.openGraph?.url).toBe(`${SITE_ORIGIN}/explore/black-holes`);
    expect(metadata.title).toContain('Black Holes');
    expect(metadata.description).toContain('black holes');
    expect(metadata.openGraph?.images).toBeTruthy();
  });

  it('marks unknown slugs as non-indexable instead of assigning the homepage canonical', async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: 'not-a-topic' }) });
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBeUndefined();
  });

  it('throws a not-found response for an unknown topic page', async () => {
    await expect(ExploreTopicPage({ params: Promise.resolve({ slug: 'not-a-topic' }) })).rejects.toThrow();
  });
});
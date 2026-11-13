import { describe, expect, it } from 'vitest';
import { exploreTopics, validateExploreTopics } from './exploreTopics';

describe('curated explore topics', () => {
  it('has valid, unique slugs and Wikipedia titles', () => {
    expect(validateExploreTopics()).toEqual([]);
    expect(new Set(exploreTopics.map((topic) => topic.slug)).size).toBe(exploreTopics.length);
    expect(exploreTopics.every((topic) => topic.wikipediaTitle.trim().length > 0)).toBe(true);
  });

  it('references only curated related topics', () => {
    const slugs = new Set(exploreTopics.map((topic) => topic.slug));
    for (const topic of exploreTopics) {
      expect(topic.relatedTopics.length).toBeGreaterThan(0);
      expect(topic.relatedTopics.every((slug) => slugs.has(slug))).toBe(true);
    }
  });

  it('detects invalid slugs, duplicate slugs, and broken references', () => {
    const issues = validateExploreTopics([
      { ...exploreTopics[0]!, slug: 'Bad Slug', relatedTopics: ['missing'] },
      { ...exploreTopics[1]!, slug: 'Bad Slug' },
    ]);

    expect(issues).toContain('Invalid slug: Bad Slug');
    expect(issues).toContain('Duplicate slug: Bad Slug');
    expect(issues).toContain('Unknown related topic missing in Bad Slug');
  });
});
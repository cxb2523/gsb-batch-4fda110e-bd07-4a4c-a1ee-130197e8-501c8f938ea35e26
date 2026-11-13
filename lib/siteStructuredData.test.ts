import { describe, expect, it } from 'vitest';
import { SITE_ORIGIN } from './site';
import { siteStructuredData } from './siteStructuredData';

describe('site structured data', () => {
  it('contains one WikiCrawl WebSite and preserves one WebApplication', () => {
    const graph = siteStructuredData['@graph'];
    const websites = graph.filter((entry) => entry['@type'] === 'WebSite');
    const applications = graph.filter((entry) => entry['@type'] === 'WebApplication');

    expect(websites).toEqual([{
      '@type': 'WebSite',
      name: 'WikiCrawl',
      alternateName: 'Wiki Crawl',
      url: `${SITE_ORIGIN}/`,
    }]);
    expect(applications).toHaveLength(1);
    expect(applications[0]?.name).toBe('WikiCrawl');
    expect(applications[0]?.url).toBe(`${SITE_ORIGIN}/`);
    expect(JSON.parse(JSON.stringify(siteStructuredData))).toEqual(siteStructuredData);
  });
});
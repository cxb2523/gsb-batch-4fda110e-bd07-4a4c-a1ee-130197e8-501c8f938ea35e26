import { SITE_ORIGIN } from './site';

export const siteStructuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      name: 'WikiCrawl',
      alternateName: 'Wiki Crawl',
      url: `${SITE_ORIGIN}/`,
    },
    {
      '@type': 'WebApplication',
      name: 'WikiCrawl',
      description: 'Explore Wikipedia as an interactive knowledge graph. Follow article links, map connected topics, and discover unexpected connections.',
      url: `${SITE_ORIGIN}/`,
      applicationCategory: 'EducationalApplication',
      operatingSystem: 'Any',
      inLanguage: 'en',
      isAccessibleForFree: true,
      offers: {
        '@type': 'Offer',
        price: 0,
        priceCurrency: 'USD',
      },
      featureList: [
        'Explore links between Wikipedia articles in an interactive graph',
        'Visualize topic communities and article distances',
        'Find shortest paths between connected articles',
      ],
    },
  ],
};
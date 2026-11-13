import type { MetadataRoute } from 'next';
import { exploreTopics } from '@/lib/exploreTopics';
import { learnArticles } from '@/lib/learnArticles';
import { SITE_ORIGIN } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_ORIGIN}/` },
    { url: `${SITE_ORIGIN}/explore` },
    ...exploreTopics.map((topic) => ({ url: `${SITE_ORIGIN}/explore/${topic.slug}` })),
    { url: `${SITE_ORIGIN}/learn` },
    ...learnArticles.map((article) => ({ url: `${SITE_ORIGIN}/learn/${article.slug}` })),
  ];
}

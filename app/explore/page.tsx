import type { Metadata } from 'next';
import Link from 'next/link';
import { ContentPage } from '@/app/components/ContentPage';
import { exploreTopics } from '@/lib/exploreTopics';
import { SITE_ORIGIN } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Explore Wikipedia Topics | WikiCrawl',
  description: 'Choose a curated Wikipedia topic and follow its connections through an interactive knowledge graph.',
  alternates: { canonical: '/explore' },
  openGraph: {
    type: 'website',
    siteName: 'WikiCrawl',
    url: `${SITE_ORIGIN}/explore`,
    title: 'Explore Wikipedia Topics | WikiCrawl',
    description: 'Choose a curated Wikipedia topic and follow its connections through an interactive knowledge graph.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Explore Wikipedia Topics | WikiCrawl',
    description: 'Choose a curated Wikipedia topic and follow its connections through an interactive knowledge graph.',
  },
};

const categories = [...new Set(exploreTopics.map((topic) => topic.category))];

export default function ExploreIndexPage() {
  return (
    <ContentPage>
      <main className="content-main">
        <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">Home</Link><span aria-hidden="true">/</span><span aria-current="page">Explore</span></nav>
        <header className="content-intro">
          <p className="content-kicker">CURATED FIELD NOTES / 20 STARTING POINTS</p>
          <h1>Explore Wikipedia</h1>
          <p>Start with a subject, then follow the article links around it. Each topic opens in WikiCrawl’s live graph explorer, where you can choose the crawl depth and page limit.</p>
        </header>
        <div className="topic-groups">
          {categories.map((category) => (
            <section className="topic-group" key={category} aria-labelledby={`category-${category.replaceAll(' ', '-').replaceAll('&', 'and')}`}>
              <h2 id={`category-${category.replaceAll(' ', '-').replaceAll('&', 'and')}`}>{category}</h2>
              <ul className="topic-grid">
                {exploreTopics.filter((topic) => topic.category === category).map((topic) => (
                  <li key={topic.slug}>
                    <Link className="topic-link" href={`/explore/${topic.slug}`}>
                      <span className="topic-link-title">{topic.title}</span>
                      <span className="topic-link-description">{topic.description}</span>
                      <span className="topic-link-arrow" aria-hidden="true">Explore ↗</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="content-next-step">Have another subject in mind? <Link href="/">Search any Wikipedia article and build a live graph.</Link></p>
      </main>
    </ContentPage>
  );
}
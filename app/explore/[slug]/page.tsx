import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ContentPage } from '@/app/components/ContentPage';
import { ExploreGraph } from '@/app/components/ExploreGraph';
import { loadExploreGraph } from '@/lib/exploreData';
import { exploreTopics, getExploreTopic } from '@/lib/exploreTopics';
import { SITE_ORIGIN } from '@/lib/site';
import { titleToUrl } from '@/lib/wikipedia';

type TopicRouteProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return exploreTopics.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: TopicRouteProps): Promise<Metadata> {
  const { slug } = await params;
  const topic = getExploreTopic(slug);
  if (!topic) return { title: 'Topic Not Found | WikiCrawl', robots: { index: false, follow: true } };

  const title = `${topic.title} — Wikipedia Knowledge Graph | WikiCrawl`;
  const canonical = `/explore/${topic.slug}`;
  return {
    title,
    description: topic.description,
    keywords: topic.keywords,
    alternates: { canonical },
    openGraph: {
      type: 'article',
      siteName: 'WikiCrawl',
      url: `${SITE_ORIGIN}${canonical}`,
      title,
      description: topic.description,
      images: [`/explore/${topic.slug}/opengraph-image`],
    },
    twitter: { card: 'summary_large_image', title, description: topic.description, images: [`/explore/${topic.slug}/opengraph-image`] },
  };
}

export default async function ExploreTopicPage({ params }: TopicRouteProps) {
  const { slug } = await params;
  const topic = getExploreTopic(slug);
  if (!topic) notFound();

  const graph = await loadExploreGraph(topic);
  const related = topic.relatedTopics.map((relatedSlug) => getExploreTopic(relatedSlug)).filter((relatedTopic) => relatedTopic !== undefined);
  const canonicalUrl = `${SITE_ORIGIN}/explore/${topic.slug}`;
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: `${topic.title} — Wikipedia Knowledge Graph | WikiCrawl`,
    description: topic.description,
    url: canonicalUrl,
    isPartOf: { '@type': 'WebSite', name: 'WikiCrawl', url: SITE_ORIGIN },
  };
  const breadcrumbData = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_ORIGIN },
      { '@type': 'ListItem', position: 2, name: 'Explore', item: `${SITE_ORIGIN}/explore` },
      { '@type': 'ListItem', position: 3, name: topic.title },
    ],
  };

  return (
    <ContentPage>
      <main className="content-main">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify([structuredData, breadcrumbData]).replace(/</g, '\\u003c') }} />
        <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">Home</Link><span aria-hidden="true">/</span><Link href="/explore">Explore</Link><span aria-hidden="true">/</span><span aria-current="page">{topic.title}</span></nav>
        <header className="content-intro">
          <p className="content-kicker">{topic.category.toUpperCase()} / WIKIPEDIA FIELD NOTE</p>
          <h1>{topic.title}</h1>
          <p>{topic.intro}</p>
        </header>

        <section className="content-section" aria-labelledby="graph-heading">
          <div className="section-heading-row">
            <div><p className="content-kicker">ARTICLE LINKS</p><h2 id="graph-heading">A map of connected pages</h2></div>
            <span className="graph-source-label">{graph ? (graph.partial ? 'SAVED PARTIAL CRAWL' : 'SAVED WIKIPEDIA CRAWL') : 'LIVE EXPLORATION AVAILABLE'}</span>
          </div>
          <ExploreGraph data={graph} topicTitle={topic.title} />
        </section>

        <div className="content-columns">
          <section className="content-section" aria-labelledby="about-heading">
            <p className="content-kicker">ABOUT THIS EXPLORATION</p>
            <h2 id="about-heading">How to read this topic</h2>
            <p>WikiCrawl follows links from the Wikipedia article for {topic.title}. The resulting map is a bounded sample, not a graph of all Wikipedia. Links preserve their direction: an arrow means the source article links to the destination article.</p>
            <p>Wikipedia’s article network provides context around this subject, while the live explorer lets you vary the crawl depth and page limit to see a different slice.</p>
          </section>
          <section className="content-section key-concepts" aria-labelledby="concepts-heading">
            <p className="content-kicker">STARTING CONCEPTS</p>
            <h2 id="concepts-heading">Related areas</h2>
            <ul>{topic.keywords.map((keyword) => <li key={keyword}>{keyword}</li>)}</ul>
            <p className="concepts-note">These are subject areas for context, not claims that a particular saved crawl discovered each link.</p>
          </section>
        </div>

        <section className="content-section related-section" aria-labelledby="related-heading">
          <p className="content-kicker">KEEP FOLLOWING THE LINKS</p>
          <h2 id="related-heading">Related WikiCrawl topics</h2>
          <ul className="related-topic-list">{related.map((relatedTopic) => <li key={relatedTopic.slug}><Link href={`/explore/${relatedTopic.slug}`}>{relatedTopic.title}<span aria-hidden="true"> ↗</span></Link></li>)}</ul>
        </section>

        <section className="source-row" aria-labelledby="source-heading">
          <div><p className="content-kicker">SOURCE ARTICLE</p><h2 id="source-heading">Read the original on Wikipedia</h2><p>WikiCrawl maps article links; the source article provides the full topic coverage.</p></div>
          <a className="text-link" href={titleToUrl(topic.wikipediaTitle)} target="_blank" rel="noreferrer">{topic.wikipediaTitle} on Wikipedia <span aria-hidden="true">↗</span></a>
        </section>

        <section className="explore-cta" aria-labelledby="cta-heading">
          <div><p className="content-kicker">YOUR TURN</p><h2 id="cta-heading">Take {topic.title} into the live graph.</h2><p>Choose how far WikiCrawl follows article links and inspect the resulting map.</p></div>
          <Link className="primary-text-link" href={`/?seed=${encodeURIComponent(topic.wikipediaTitle)}`}>Explore this topic in WikiCrawl <span aria-hidden="true">↗</span></Link>
        </section>
        <p className="content-next-step">Read more about <Link href="/learn/wikipedia-knowledge-graph">Wikipedia knowledge graphs</Link> or return to <Link href="/explore">all curated topics</Link>.</p>
      </main>
    </ContentPage>
  );
}
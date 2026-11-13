import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { ContentPage } from '@/app/components/ContentPage';
import { getLearnArticle, learnArticles } from '@/lib/learnArticles';
import { getExploreTopic } from '@/lib/exploreTopics';
import { SITE_ORIGIN } from '@/lib/site';

type LearnRouteProps = { params: Promise<{ slug: string }> };

function renderParagraph(paragraph: string): ReactNode[] {
  return paragraph.split(/(\[\[[a-z0-9-]+\|[^\]]+\]\])/g).map((part, index) => {
    const match = /^\[\[([a-z0-9-]+)\|([^\]]+)\]\]$/.exec(part);
    if (!match) return part;
    const [, slug, label] = match;
    if (slug === 'explore') return <Link key={index} href="/explore">{label}</Link>;
    const topic = getExploreTopic(slug ?? '');
    return topic ? <Link key={index} href={`/explore/${topic.slug}`}>{label}</Link> : label;
  });
}

export function generateStaticParams() {
  return learnArticles.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: LearnRouteProps): Promise<Metadata> {
  const { slug } = await params;
  const article = getLearnArticle(slug);
  if (!article) return { title: 'Article Not Found | WikiCrawl', robots: { index: false, follow: true } };

  const title = `${article.title} | WikiCrawl`;
  const canonical = `/learn/${article.slug}`;
  return {
    title,
    description: article.description,
    alternates: { canonical },
    openGraph: { type: 'article', siteName: 'WikiCrawl', url: `${SITE_ORIGIN}${canonical}`, title, description: article.description },
    twitter: { card: 'summary_large_image', title, description: article.description },
  };
}

export default async function LearnArticlePage({ params }: LearnRouteProps) {
  const { slug } = await params;
  const article = getLearnArticle(slug);
  if (!article) notFound();

  const canonicalUrl = `${SITE_ORIGIN}/learn/${article.slug}`;
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: article.title,
    description: article.description,
    url: canonicalUrl,
    isPartOf: { '@type': 'WebSite', name: 'WikiCrawl', url: SITE_ORIGIN },
  };
  const breadcrumbData = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_ORIGIN },
      { '@type': 'ListItem', position: 2, name: 'Learn', item: `${SITE_ORIGIN}/learn` },
      { '@type': 'ListItem', position: 3, name: article.title },
    ],
  };
  const relatedTopics = article.relatedTopics.map((topicSlug) => getExploreTopic(topicSlug)).filter((topic) => topic !== undefined);

  return (
    <ContentPage>
      <main className="content-main article-main">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify([structuredData, breadcrumbData]).replace(/</g, '\\u003c') }} />
        <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">Home</Link><span aria-hidden="true">/</span><Link href="/learn">Learn</Link><span aria-hidden="true">/</span><span aria-current="page">{article.title}</span></nav>
        <header className="content-intro">
          <p className="content-kicker">WIKICRAWL FIELD GUIDE</p>
          <h1>{article.title}</h1>
          <p>{article.intro}</p>
        </header>
        <article className="article-body">
          {article.sections.map((section) => (
            <section key={section.heading} aria-labelledby={`section-${section.heading.replaceAll(' ', '-').toLowerCase()}`}>
              <h2 id={`section-${section.heading.replaceAll(' ', '-').toLowerCase()}`}>{section.heading}</h2>
              {section.paragraphs.map((paragraph, index) => <p key={index}>{renderParagraph(paragraph)}</p>)}
            </section>
          ))}
        </article>
        <section className="content-section related-section" aria-labelledby="related-topics-heading">
          <p className="content-kicker">CONTINUE EXPLORING</p>
          <h2 id="related-topics-heading">Related topic maps</h2>
          <ul className="related-topic-list">{relatedTopics.map((topic) => <li key={topic.slug}><Link href={`/explore/${topic.slug}`}>{topic.title}<span aria-hidden="true"> ↗</span></Link></li>)}</ul>
        </section>
        <p className="content-next-step"><Link href="/learn">Back to the field guide</Link> · <Link href="/">Open WikiCrawl</Link></p>
      </main>
    </ContentPage>
  );
}
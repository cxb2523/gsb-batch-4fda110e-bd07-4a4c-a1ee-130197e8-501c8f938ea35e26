import type { Metadata } from 'next';
import Link from 'next/link';
import { ContentPage } from '@/app/components/ContentPage';
import { learnArticles } from '@/lib/learnArticles';
import { SITE_ORIGIN } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Learn About Wikipedia’s Hidden Connections | WikiCrawl',
  description: 'Short, practical guides to Wikipedia rabbit holes, article-link graphs, and how WikiCrawl explores them.',
  alternates: { canonical: '/learn' },
  openGraph: {
    type: 'website',
    siteName: 'WikiCrawl',
    url: `${SITE_ORIGIN}/learn`,
    title: 'Learn About Wikipedia’s Hidden Connections | WikiCrawl',
    description: 'Short, practical guides to Wikipedia rabbit holes, article-link graphs, and how WikiCrawl explores them.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Learn About Wikipedia’s Hidden Connections | WikiCrawl',
    description: 'Short, practical guides to Wikipedia rabbit holes, article-link graphs, and how WikiCrawl explores them.',
  },
};

export default function LearnIndexPage() {
  return (
    <ContentPage>
      <main className="content-main">
        <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">Home</Link><span aria-hidden="true">/</span><span aria-current="page">Learn</span></nav>
        <header className="content-intro">
          <p className="content-kicker">FIELD GUIDE / WIKIPEDIA, MAPPED</p>
          <h1>Learn About Wikipedia’s Hidden Connections</h1>
          <p>Clear explanations of article links, knowledge graphs, and the choices behind WikiCrawl’s maps.</p>
        </header>
        <ul className="article-grid">
          {learnArticles.map((article, index) => (
            <li key={article.slug}>
              <Link className="article-link" href={`/learn/${article.slug}`}>
                <span className="article-index">NOTE {String(index + 1).padStart(2, '0')}</span>
                <span className="article-link-title">{article.title}</span>
                <span className="article-link-description">{article.description}</span>
                <span className="topic-link-arrow" aria-hidden="true">Read article ↗</span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="content-next-step">Ready to follow links? <Link href="/explore">Choose a curated exploration</Link> or <Link href="/">search Wikipedia live</Link>.</p>
      </main>
    </ContentPage>
  );
}
import Link from 'next/link';

export default function LearnArticleNotFound() {
  return (
    <main className="content-not-found">
      <p className="content-kicker">ARTICLE NOT FOUND</p>
      <h1>This field guide page does not exist.</h1>
      <p>Browse the published guides or return to the WikiCrawl explorer.</p>
      <p><Link href="/learn">Browse the field guide</Link> <span aria-hidden="true">·</span> <Link href="/">Open WikiCrawl</Link></p>
    </main>
  );
}
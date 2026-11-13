import Link from 'next/link';

export default function ExploreTopicNotFound() {
  return (
    <main className="content-not-found">
      <p className="content-kicker">FIELD NOTE NOT FOUND</p>
      <h1>This topic is not in the curated atlas.</h1>
      <p>Browse the available starting points or use the live explorer to search for any Wikipedia article.</p>
      <p><Link href="/explore">Browse explore topics</Link> <span aria-hidden="true">·</span> <Link href="/">Open WikiCrawl</Link></p>
    </main>
  );
}
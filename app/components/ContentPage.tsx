import Link from 'next/link';

export function ContentPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="content-page">
      <header className="content-header">
        <Link className="content-brand" href="/" aria-label="WikiCrawl home">
          <span aria-hidden="true">{'///'}</span> WikiCrawl
        </Link>
        <nav aria-label="Main navigation">
          <Link href="/explore">Explore</Link>
          <Link href="/learn">Learn</Link>
          <Link className="content-header-cta" href="/">Open the graph <span aria-hidden="true">↗</span></Link>
        </nav>
      </header>
      {children}
      <footer className="content-footer">
        <span>Wikipedia, mapped by WikiCrawl</span>
        <nav aria-label="Footer navigation">
          <Link href="/explore">Explore topics</Link>
          <Link href="/learn">Learn</Link>
          <Link href="/">Start a live crawl</Link>
        </nav>
      </footer>
    </div>
  );
}
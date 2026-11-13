'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error('WikiCrawl route error:', error);
  }, [error]);

  return (
    <main className="app-shell flex min-h-screen items-center justify-center px-6 py-12">
      <section className="w-full max-w-xl border border-[var(--line)] border-l-4 border-l-[var(--signal-warm)] bg-[var(--ink-soft)] p-8" role="alert">
        <p className="font-mono text-xs uppercase text-[var(--signal-cool)]">{'///'} Field note interrupted</p>
        <h1 className="mt-4 text-2xl font-medium text-[var(--paper)]">This view ran into an error.</h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--paper-dim)]">Your browser is still here. Try rendering the page again; your crawl can be reopened from its URL.</p>
        <button
          type="button"
          onClick={() => retry()}
          className="mt-6 min-h-11 border border-[var(--signal)] bg-[var(--signal)] px-4 font-mono text-xs font-semibold uppercase text-[var(--ink)] hover:bg-[var(--paper)]"
        >
          Try again
        </button>
        {error.digest && <p className="mt-4 font-mono text-xs text-[var(--atlas-dim)]">Reference: {error.digest}</p>}
      </section>
    </main>
  );
}

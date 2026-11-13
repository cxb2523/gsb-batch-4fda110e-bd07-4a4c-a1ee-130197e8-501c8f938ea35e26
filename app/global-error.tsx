'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error('WikiCrawl root error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#111613', color: '#edf0e7', fontFamily: 'Arial, sans-serif' }}>
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
          <section role="alert" style={{ width: '100%', maxWidth: 560, boxSizing: 'border-box', border: '1px solid rgba(222,232,218,.18)', borderLeft: '4px solid #f48670', background: '#19211d', padding: 32 }}>
            <p style={{ color: '#77c9bd', fontFamily: 'monospace', fontSize: 12, textTransform: 'uppercase' }}>{'///'} WikiCrawl · field note interrupted</p>
            <h1 style={{ margin: '20px 0 12px', fontSize: 28, fontWeight: 500 }}>The app hit an unexpected error.</h1>
            <p style={{ color: '#bdc6bb', fontSize: 15, lineHeight: 1.6 }}>The page can be retried without refreshing the browser.</p>
            <button type="button" onClick={() => retry()} style={{ minHeight: 44, marginTop: 12, border: 0, background: '#d8f27a', padding: '0 18px', color: '#111613', fontFamily: 'monospace', fontWeight: 700, textTransform: 'uppercase', cursor: 'pointer' }}>
              Try again
            </button>
            {error.digest && <p style={{ color: '#919d93', fontFamily: 'monospace', fontSize: 12 }}>Reference: {error.digest}</p>}
          </section>
        </main>
      </body>
    </html>
  );
}

import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { Analytics } from '@vercel/analytics/next';
import { SITE_ORIGIN, SITE_URL } from '@/lib/site';
import { siteStructuredData } from '@/lib/siteStructuredData';

export const metadata: Metadata = {
  title: 'WikiCrawl — Explore Wikipedia as an Interactive Knowledge Graph',
  metadataBase: SITE_URL,
  applicationName: 'WikiCrawl',
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml', sizes: '64x64' }],
  },
  description: 'Explore Wikipedia as an interactive knowledge graph. Follow article links, discover unexpected connections, and find your next Wikipedia rabbit hole with WikiCrawl.',
  keywords: [
    'Wikipedia graph',
    'Wikipedia link explorer',
    'knowledge graph',
    'Wikipedia visualization',
    'article connections',
  ],
  category: 'education',
  creator: 'Adityavardhan Jain',
  publisher: 'WikiCrawl',
  referrer: 'origin-when-cross-origin',
  alternates: {
    canonical: '/',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  openGraph: {
    type: 'website',
    siteName: 'WikiCrawl',
    url: SITE_ORIGIN,
    title: 'WikiCrawl — Explore Wikipedia as an Interactive Knowledge Graph',
    description: 'Explore Wikipedia as an interactive knowledge graph. Follow article links, discover unexpected connections, and find your next Wikipedia rabbit hole.',
    locale: 'en_US',
    images: [
      {
        url: '/opengraph-image',
        width: 1200,
        height: 630,
        alt: 'WikiCrawl maps Wikipedia article links as an interactive knowledge graph',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'WikiCrawl — Explore Wikipedia as an Interactive Knowledge Graph',
    description: 'Explore Wikipedia as an interactive knowledge graph. Follow article links, discover unexpected connections, and find your next Wikipedia rabbit hole.',
    images: ['/twitter-image'],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta
          name="google-site-verification"
          content="0yJlFEgw5f_6CHdB7O7_ataM8Zbh4eleFXKfXeBGxwY"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(siteStructuredData).replace(/</g, '\\u003c'),
          }}
        />
      </head>
      <body className="app-fonts">
        <Providers>
          {children}
        </Providers>
        <Analytics />
      </body>
    </html>
  );
}

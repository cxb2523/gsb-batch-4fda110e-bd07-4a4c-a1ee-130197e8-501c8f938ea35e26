export const SITE_URL = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://wiki-crawl.vercel.app',
);

export const SITE_ORIGIN = SITE_URL.origin;

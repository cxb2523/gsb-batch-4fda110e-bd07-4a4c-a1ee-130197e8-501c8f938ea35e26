/**
 * The only paths served without signing in: the landing page, its images in
 * public/, and what crawlers and link previews fetch. Nothing under the app or the API is here. Anything added must
 * work without a user and read nothing that belongs to one.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/icon.svg",
  "/shiro-logo.svg",
  "/robots.txt",
  "/sitemap.xml",
  "/opengraph-image",
]);

/** The folder in public/ that holds only the landing page's images. No route lives under it. */
const PUBLIC_ASSET_FOLDER = "/landing/";

/** A plain file path: no dot segments, encoded characters or backslashes that could resolve somewhere else. */
const PLAIN_FILE = /^(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)+$/;

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PLAIN_FILE.test(pathname) && pathname.startsWith(PUBLIC_ASSET_FOLDER);
}

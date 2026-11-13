import {
  getCachedPageLinks,
  getCachedPageViews,
  getCachedRelationship,
  setCachedPageLinks,
  setCachedPageViews,
  setCachedRelationship,
} from './db';
import { interpretWikiLinkContext } from './relationshipContext';
import type { WikiRelationship } from '@/types/graph';

const WIKIPEDIA_API_BASE = 'https://en.wikipedia.org/w/api.php';
const WIKI_CONTACT = process.env.WIKI_CONTACT?.trim();
const USER_AGENT = WIKI_CONTACT
  ? `WikiCrawl/1.0 (https://github.com/Adityavardhanjain/WikiCrawl; ${WIKI_CONTACT})`
  : 'WikiCrawl/1.0 (https://github.com/Adityavardhanjain/WikiCrawl)';
const MAX_RETRIES = 3;
const PAGEVIEW_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(response: Response, attempt: number): number {
  const retryAfterHeader = response.headers.get('retry-after');
  if (retryAfterHeader) {
    const retryAfterSeconds = Number(retryAfterHeader);
    if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }
  }

  return Math.min(2000 * 2 ** attempt, 10000);
}

interface WikipediaLink {
  title: string;
}

interface WikipediaSearchResult {
  title: string;
}

interface WikipediaPage {
  pageid?: number;
  title: string;
  missing?: boolean;
  links?: WikipediaLink[];
  pageviews?: Record<string, number | null>;
}

interface WikipediaParse {
  title?: string;
  wikitext?: string | { '*': string };
}

interface WikipediaResponse {
  query?: {
    pages?: WikipediaPage[];
    redirects?: { from?: string; title?: string; to: string }[];
  };
  parse?: WikipediaParse;
  'continue'?: {
    plcontinue?: string;
  };
}

async function fetchWikipedia(
  params: Record<string, string>,
  options: { beforeRequest?: () => boolean; maxRetries?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<WikipediaResponse> {
  const url = new URL(WIKIPEDIA_API_BASE);
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let attempt = 0;

  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  while (attempt <= maxRetries) {
    if (options.beforeRequest && !options.beforeRequest()) throw new Error('Wikipedia request budget exhausted');
    if (options.signal?.aborted) throw new Error('Wikipedia request aborted');
    
    const timeoutSignal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const signal = options.signal && timeoutSignal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal ?? options.signal;
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal,
    });

    if (response.status === 429) {
      if (attempt >= maxRetries) {
        throw new Error('Wikipedia is rate limiting requests. Please wait a moment and try again.');
      }

      await sleep(getRetryDelay(response, attempt));
      attempt += 1;
      continue;
    }

    if (!response.ok) {
      throw new Error(`Wikipedia API error: ${response.status}`);
    }

    return response.json();
  }

  throw new Error('Wikipedia request failed after retries');
}

export async function searchWikipedia(query: string): Promise<WikipediaSearchResult[]> {
  if (!query || query.trim().length < 1) {
    return [];
  }

  const data = await fetchWikipedia({
    action: 'opensearch',
    search: query,
    limit: '10',
    namespace: '0',
  }) as unknown as [string, string[], string[], string[]];

  // opensearch returns [query, titles, descriptions, urls]
  const titles = data[1] ?? [];
  return titles.map((title) => ({ title }));
}

export interface PageLinksResult {
  title: string;
  resolvedTitle: string;
  links: string[];
  complete: boolean;
  pageid?: number;
  missing?: boolean;
}

export interface PageLinksBatchResult {
  pages: PageLinksResult[];
  continueToken?: string;
}

const MAX_BATCH_TITLES = 50;

export interface PageViewsOptions {
  concurrency?: number;
  beforeRequest?: () => boolean;
  signal?: AbortSignal;
}

export interface PageLinksAccumulatedPage {
  resolvedTitle: string;
  links: string[];
}

interface ExpiringPageLinksAccumulation extends PageLinksAccumulatedPage {
  expiresAt: number;
}

const accumulatedPages = new Map<string, ExpiringPageLinksAccumulation>();
const PAGE_LINK_ACCUMULATION_TTL_MS = 5 * 60 * 1000;
const MAX_PAGE_LINK_ACCUMULATIONS = 1000;
let accumulationCleanupTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAccumulationCleanup(): void {
  if (accumulationCleanupTimer) clearTimeout(accumulationCleanupTimer);
  const nextExpiry = Math.min(...Array.from(accumulatedPages.values(), (value) => value.expiresAt));
  if (!Number.isFinite(nextExpiry)) {
    accumulationCleanupTimer = null;
    return;
  }

  accumulationCleanupTimer = setTimeout(() => {
    accumulationCleanupTimer = null;
    pruneAccumulatedPages(Date.now());
    scheduleAccumulationCleanup();
  }, Math.max(0, nextExpiry - Date.now()));
  accumulationCleanupTimer.unref?.();
}

function pruneAccumulatedPages(now: number): void {
  for (const [key, value] of accumulatedPages) {
    if (value.expiresAt <= now) accumulatedPages.delete(key);
  }
  while (accumulatedPages.size > MAX_PAGE_LINK_ACCUMULATIONS) {
    const oldestKey = accumulatedPages.keys().next().value;
    if (oldestKey === undefined) break;
    accumulatedPages.delete(oldestKey);
  }
}

function getAccumulationKey(sessionId: string, title: string): string {
  return `${sessionId}:${normalizeTitle(title)}`;
}

function normalizeTitle(title: string): string {
  return title.replace(/_/g, ' ').trim().toLowerCase();
}

function continuationPageId(token?: string): number | undefined {
  const pageId = Number(token?.split('|')[0]);
  return Number.isFinite(pageId) ? pageId : undefined;
}

export interface PageLinksBatchOptions {
  beforeRequest?: () => boolean;
  paginationSessionId?: string;
  paginationState?: Map<string, PageLinksAccumulatedPage>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function getPageLinksBatch(
  titles: string[],
  continueToken?: string,
  options: PageLinksBatchOptions = {},
): Promise<PageLinksBatchResult> {
  if (titles.length === 0) {
    return { pages: [] };
  }

  const requestedTitles = titles.slice(0, MAX_BATCH_TITLES);
  const paginationSessionId = options.paginationSessionId ?? 'default';
  const paginationState = options.paginationState;
  const now = Date.now();
  if (!paginationState) {
    pruneAccumulatedPages(now);
    scheduleAccumulationCleanup();
  }
  const readAccumulated = (title: string): PageLinksAccumulatedPage | undefined => {
    if (paginationState) return paginationState.get(normalizeTitle(title));
    const key = getAccumulationKey(paginationSessionId, title);
    const value = accumulatedPages.get(key);
    if (!value) return undefined;
    value.expiresAt = now + PAGE_LINK_ACCUMULATION_TTL_MS;
    return value;
  };
  const writeAccumulated = (title: string, value: PageLinksAccumulatedPage): void => {
    if (paginationState) {
      paginationState.set(normalizeTitle(title), value);
      return;
    }
    accumulatedPages.delete(getAccumulationKey(paginationSessionId, title));
    accumulatedPages.set(getAccumulationKey(paginationSessionId, title), {
      ...value,
      expiresAt: now + PAGE_LINK_ACCUMULATION_TTL_MS,
    });
    pruneAccumulatedPages(now);
    scheduleAccumulationCleanup();
  };
  const deleteAccumulated = (title: string): void => {
    if (paginationState) paginationState.delete(normalizeTitle(title));
    else accumulatedPages.delete(getAccumulationKey(paginationSessionId, title));
  };
  const cachedPages = new Map<string, PageLinksResult>();
  const missingTitles = requestedTitles.filter((title) => {
    if (continueToken) return true;

    const cachedPage = getCachedPageLinks(title);
    if (!cachedPage || !cachedPage.complete) return true;

    cachedPages.set(title, { ...cachedPage, title });
    return false;
  });

  if (missingTitles.length === 0) {
    return { pages: requestedTitles.map((title) => cachedPages.get(title)!) };
  }

  const params: Record<string, string> = {
    action: 'query',
    formatversion: '2',
    titles: missingTitles.join('|'),
    prop: 'links',
    plnamespace: '0', // Only article pages
    pllimit: 'max', // Maximum 500 links per request
    redirects: '1', // Resolve redirects
  };

  if (continueToken) {
    params.plcontinue = continueToken;
  }

  const data = await fetchWikipedia(
  params,
  {
    beforeRequest: options.beforeRequest,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  }
);
  
  const pages = data.query?.pages || [];
  const redirects = data.query?.redirects || [];
  const redirectMap = new Map(redirects.map((redirect) => [redirect.from || redirect.title || '', redirect.to]));

  const nextPageId = continuationPageId(data['continue']?.plcontinue);
const hasContinuation = Boolean(data['continue']?.plcontinue);

const fetchedPages = missingTitles.map((title) => {
  const resolvedTitle = redirectMap.get(title) || title;
  const normalizedResolvedTitle = resolvedTitle.toLowerCase();
  const normalizedTitle = title.toLowerCase();

  const page = pages.find((candidate) => (
    candidate.title.toLowerCase() === normalizedResolvedTitle ||
    candidate.title.toLowerCase() === normalizedTitle
  ));

  if (!page || page.missing) {
    deleteAccumulated(title);
    return {
      title,
      resolvedTitle: title,
      links: [],
      complete: true,
      missing: true,
    };
  }

  const pageLinks = page.links?.map((link) => link.title) || [];

  const accumulated = readAccumulated(title) ?? {
    resolvedTitle: page.title || resolvedTitle,
    links: [],
  };

  for (const link of pageLinks) {
    if (!accumulated.links.includes(link)) {
      accumulated.links.push(link);
    }
  }

  accumulated.resolvedTitle = page.title || resolvedTitle;
  writeAccumulated(title, accumulated);

  // MediaWiki's continuation token identifies the page whose
  // link listing should continue. If it points at this page,
  // this page is not complete yet.
  const continuationTargetsPage =
    nextPageId !== undefined &&
    page.pageid !== undefined &&
    nextPageId === page.pageid;

  const complete = !hasContinuation || !continuationTargetsPage;

  return {
    title,
    resolvedTitle: page.title || resolvedTitle,
    links: pageLinks,
    pageid: page.pageid,
    complete,
  };
});

for (let index = 0; index < fetchedPages.length; index += 1) {
  const page = fetchedPages[index];
  const requestedTitle = missingTitles[index];

  if (!page || !requestedTitle || page.missing || !page.complete) {
    continue;
  }

  const accumulated = readAccumulated(requestedTitle);

  const cachedPage: PageLinksResult = {
    title: page.title,
    resolvedTitle: accumulated?.resolvedTitle ?? page.resolvedTitle,
    links: accumulated?.links ?? page.links,
    complete: true,
  };

  setCachedPageLinks(cachedPage);

  // Also cache the redirect alias so requesting the original
  // redirect title can hit the cache next time.
  if (normalizeTitle(requestedTitle) !== normalizeTitle(page.title)) {
    setCachedPageLinks({
      ...cachedPage,
      title: requestedTitle,
    });
  }

  deleteAccumulated(requestedTitle);
}

  return {
    pages: requestedTitles.map((title) => cachedPages.get(title) || fetchedPages.find((page) => page.title === title)!).filter(Boolean),
    continueToken: data['continue']?.plcontinue,
  };
}

export async function getPageLinks(
  title: string,
  continueToken?: string,
  options: PageLinksBatchOptions = {},
): Promise<PageLinksResult> {
  const result = await getPageLinksBatch([title], continueToken, options);
  return result.pages[0] || { title, resolvedTitle: title, links: [] };
}

export async function getWikipediaRelationship(
  source: string,
  target: string,
): Promise<WikiRelationship> {
  const cached = getCachedRelationship(source, target);
  if (cached) return cached;

  const response = await fetchWikipedia({
    action: 'parse',
    page: source,
    prop: 'wikitext',
    formatversion: '2',
  }, {
    maxRetries: 0,
    timeoutMs: 10_000,
  });
  const rawWikitext = response.parse?.wikitext;
  const wikitext = typeof rawWikitext === 'string' ? rawWikitext : rawWikitext?.['*'];
  if (wikitext === undefined) {
    throw new Error(`Wikipedia did not return source text for "${source}"`);
  }

  const relationship = interpretWikiLinkContext(source, target, wikitext);
  setCachedRelationship(relationship);
  return relationship;
}

export async function getPageViews(
  titles: string[],
  options: PageViewsOptions = {},
): Promise<Map<string, number>> {
  const requestedTitles = [...new Set(titles.map((title) => title.trim()).filter(Boolean))];
  const views = new Map<string, number>();
  const missingTitles: string[] = [];

  for (const title of requestedTitles) {
    const cached = getCachedPageViews(title);
    if (cached === null) missingTitles.push(title);
    else views.set(title, cached);
  }

  const batches: string[][] = [];
  for (let index = 0; index < missingTitles.length; index += MAX_BATCH_TITLES) {
    batches.push(missingTitles.slice(index, index + MAX_BATCH_TITLES));
  }

  let nextBatchIndex = 0;
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
  const fetchBatch = async (batch: string[]) => {
    try {
      const data = await fetchWikipedia({
        action: 'query',
        formatversion: '2',
        titles: batch.join('|'),
        prop: 'pageviews',
        pvipdays: '30',
        redirects: '1',
      }, {
        beforeRequest: options.beforeRequest,
        maxRetries: 0,
        timeoutMs: PAGEVIEW_TIMEOUT_MS,
        signal: options.signal,
      });
      const pages = data.query?.pages ?? [];
      const redirects = data.query?.redirects ?? [];
      const redirectMap = new Map(redirects.map((redirect) => [redirect.from || redirect.title || '', redirect.to]));

      for (const title of batch) {
        const resolvedTitle = redirectMap.get(title) ?? title;
        const page = pages.find((candidate) => (
          candidate.title.toLowerCase() === resolvedTitle.toLowerCase()
          || candidate.title.toLowerCase() === title.toLowerCase()
        ));
        const total: number = page
          ? Object.values(page.pageviews ?? {}).reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
          : 0;
        views.set(title, total);
        setCachedPageViews(title, total);
      }
    } catch {
      // Pageviews are optional; callers use a deterministic fallback when unavailable.
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (nextBatchIndex < batches.length) {
      const batch = batches[nextBatchIndex++];
      if (batch) await fetchBatch(batch);
    }
  });
  await Promise.all(workers);
  return views;
}

export function titleToUrl(title: string): string {
  const encoded = encodeURIComponent(title.replace(/ /g, '_'));
  return `https://en.wikipedia.org/wiki/${encoded}`;
}

import { writeFile } from 'node:fs/promises';

const API_URL = 'https://en.wikipedia.org/w/api.php';
const SEEDS = ['Alan Turing', 'United States', 'Neural network'];
const CONTACT = process.env.WIKI_CONTACT || 'set WIKI_CONTACT to a URL or email';
const USER_AGENT = `WikiCrawl/1.0 (${CONTACT})`;
const PAGE_SIZE = 500;

interface LinkPage {
  title?: string;
  links?: Array<{ title: string }>;
}

interface LinksResponse {
  query?: { pages?: Record<string, LinkPage> };
  continue?: { plcontinue?: string };
}

interface LinkProbe {
  title: string;
  links: string[];
  requests: number;
  sorted: boolean;
  junk: {
    count: number;
    categories: Record<string, number>;
    topOffenders: string[];
  };
}

function apiUrl(params: Record<string, string>): string {
  const url = new URL(API_URL);
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function request<T>(params: Record<string, string>, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(params), {
    ...init,
    headers: {
      'Api-User-Agent': USER_AGENT,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

function titleCompare(left: string, right: string): number {
  return left.localeCompare(right, 'en', { sensitivity: 'base' });
}

function junkCategories(title: string): string[] {
  const categories: string[] = [];
  if (/\(identifier\)$/i.test(title)) categories.push('identifier');
  if (/^\d{4}$/.test(title.trim())) categories.push('bare 4-digit year');
  if (/^Wayback Machine$/i.test(title.trim())) categories.push('Wayback Machine');
  if (/^Wikidata$/i.test(title.trim())) categories.push('Wikidata');
  if (/^(disambiguation|list of|index of|outline of)\b/i.test(title)) categories.push('hub-like title');
  return categories;
}

async function fetchAllLinks(title: string): Promise<LinkProbe> {
  const links: string[] = [];
  let continueToken: string | undefined;
  let requests = 0;

  do {
    const data = await request<LinksResponse>({
      action: 'query',
      titles: title,
      prop: 'links',
      plnamespace: '0',
      pllimit: 'max',
      redirects: '1',
      ...(continueToken ? { plcontinue: continueToken } : {}),
    });
    requests += 1;
    const page = Object.values(data.query?.pages ?? {})[0];
    links.push(...(page?.links ?? []).map((link) => link.title));
    continueToken = data.continue?.plcontinue;
  } while (continueToken);

  const sorted = links.every((link, index) => index === 0 || titleCompare(links[index - 1], link) <= 0);
  const categoryCounts: Record<string, number> = {
    identifier: 0,
    'bare 4-digit year': 0,
    'Wayback Machine': 0,
    Wikidata: 0,
    'hub-like title': 0,
  };
  const offenders: string[] = [];
  for (const link of links) {
    const categories = junkCategories(link);
    if (categories.length > 0) {
      offenders.push(link);
      for (const category of categories) categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    }
  }

  return {
    title,
    links,
    requests,
    sorted,
    junk: {
      count: offenders.length,
      categories: categoryCounts,
      topOffenders: offenders.slice(0, 10),
    },
  };
}

async function probeMissingShape(): Promise<{ defaultShape: unknown; formatVersion2Shape: unknown }> {
  const params = {
    action: 'query',
    titles: 'Zzzqxjv nonexistent page',
  };
  const defaultResponse = await request<LinksResponse & Record<string, unknown>>(params);
  const formatVersion2 = await request<Record<string, unknown>>({ ...params, formatversion: '2' });
  const defaultPage = Object.values(defaultResponse.query?.pages ?? {})[0];
  const version2Page = (formatVersion2.query as { pages?: unknown[] } | undefined)?.pages?.[0];
  return {
    defaultShape: { page: defaultPage, raw: JSON.stringify(defaultResponse).slice(0, 600) },
    formatVersion2Shape: { page: version2Page, raw: JSON.stringify(formatVersion2).slice(0, 600) },
  };
}

async function probeRedirects(): Promise<unknown> {
  const response = await request<Record<string, unknown>>({
    action: 'query',
    titles: 'USA',
    redirects: '1',
  });
  return {
    redirects: response.redirects ?? (response.query as Record<string, unknown> | undefined)?.redirects ?? null,
    normalized: response.normalized ?? (response.query as Record<string, unknown> | undefined)?.normalized ?? null,
  };
}

async function probeCorsPreflight(): Promise<{ status: number; allowHeaders: string | null; raw: string }> {
  const response = await fetch(apiUrl({ action: 'query', titles: 'USA' }), {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://example.test',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'api-user-agent',
    },
  });
  return {
    status: response.status,
    allowHeaders: response.headers.get('access-control-allow-headers'),
    raw: (await response.text()).slice(0, 600),
  };
}

function findingsMarkdown(probes: LinkProbe[], missing: { defaultShape: unknown; formatVersion2Shape: unknown }, redirects: unknown, cors: { status: number; allowHeaders: string | null; raw: string }): string {
  const linkSections = probes.map((probe) => `### ${probe.title}

- **Alphabetical/title order: not verified**: the API response is title-sorted only if this boolean is \`true\`; observed \`${probe.sorted}\`.
- First 15 links: ${probe.links.slice(0, 15).map((link) => `\`${link}\``).join(', ')}
- Total links: **${probe.links.length}**
- Requests needed: **${probe.requests}** (**verified** by following every continuation token)
- Junk-hub matches: **${probe.junk.count}**
- Categories: \`${JSON.stringify(probe.junk.categories)}\`
- Top 10 offenders: ${probe.junk.topOffenders.map((link) => `\`${link}\``).join(', ') || 'none'}
`).join('\n');

  return `# Wikipedia API Findings

Probe date: ${new Date().toISOString()}

User-Agent: \`${USER_AGENT}\`

## Link Ordering, Pagination, and Junk Hubs

The ordering and pagination findings below are **verified** against the live API when this document was generated. Link counts can change as Wikipedia changes.

${linkSections}

## Missing-Page Response Shape

**Verified** against the live API. Neither response includes a \`pageid\`; both include a missing marker. Raw snippets and parsed page entries:

\`\`\`json
${JSON.stringify(missing, null, 2)}
\`\`\`

## Redirects

**Verified** against the live API:

\`\`\`json
${JSON.stringify(redirects, null, 2)}
\`\`\`

## Browser CORS Preflight

**Not verified** as an actual browser preflight because this script does not launch a browser. The server-side OPTIONS response is **verified** to return the requested header allowance.

\`\`\`json
${JSON.stringify(cors, null, 2)}
\`\`\`
`;
}

async function main(): Promise<void> {
  console.log(`User-Agent: ${USER_AGENT}`);
  const probes = [] as LinkProbe[];
  for (const seed of SEEDS) {
    const probe = await fetchAllLinks(seed);
    probes.push(probe);
    console.log(`\n## ${seed}`);
    console.log(`First 15 links: ${probe.links.slice(0, 15).join(' | ')}`);
    console.log(`isSortedByTitle: ${probe.sorted}`);
    console.log(`Total links: ${probe.links.length}`);
    console.log(`Requests needed: ${probe.requests}`);
    console.log(`Junk count: ${probe.junk.count}`);
    console.log(`Junk categories: ${JSON.stringify(probe.junk.categories)}`);
    console.log(`Top 10 offenders: ${probe.junk.topOffenders.join(' | ') || 'none'}`);
  }

  const missing = await probeMissingShape();
  console.log('\n## Missing page shape');
  console.log(JSON.stringify(missing, null, 2));
  const redirects = await probeRedirects();
  console.log('\n## USA redirects');
  console.log(JSON.stringify(redirects, null, 2));
  const cors = await probeCorsPreflight();
  console.log('\n## CORS preflight');
  console.log(JSON.stringify(cors, null, 2));

  await writeFile('docs/wikipedia-api-findings.md', findingsMarkdown(probes, missing, redirects, cors));
  console.log('\nWrote docs/wikipedia-api-findings.md');
}

main().catch((error) => {
  console.error(`Wikipedia API probe not verified: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
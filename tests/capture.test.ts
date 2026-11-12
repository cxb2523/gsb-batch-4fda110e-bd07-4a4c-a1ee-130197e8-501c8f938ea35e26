/**
 * Capture flow tests. Everything runs against local fakes: a hand-rolled
 * EventEmitter-style context, a fake page whose goto replays scripted request
 * events, and scripted navigation/safety failures. No browser and no real
 * LinkedIn traffic is ever involved.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPTURE_SECTIONS,
  buildCaptureReport,
  executeCapture,
  parseCapturedRequest,
  runCaptureWithDeps,
  writeCaptureReport,
  type CaptureDeps,
  type CapturePageLike,
  type CaptureRequestLike,
} from '../src/browser/capture.js';
import { BrowserSafetyError } from '../src/browser/safety.js';

let dir: string;
let outputPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-capture-'));
  outputPath = join(dir, 'catalog.json');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const ORIGIN = 'https://www.linkedin.com';

/** Build a fake voyager/non-voyager request object. */
function req(method: string, url: string): CaptureRequestLike {
  return { url: () => url, method: () => method };
}
const voyagerUrl = (path: string, query: Record<string, string> = {}): string => {
  const u = new URL(`https://www.linkedin.com/voyager/api${path}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
};

/** Scripted behavior for one section, keyed by the section URL. */
interface SectionScript {
  requests?: CaptureRequestLike[];
  navError?: Error;
}

interface FakeContext {
  on(event: 'request', listener: (r: CaptureRequestLike) => void): void;
  emit(r: CaptureRequestLike): void;
  listenerCount(): number;
}

function makeContext(): FakeContext {
  const listeners: ((r: CaptureRequestLike) => void)[] = [];
  return {
    on: (_event, listener) => {
      listeners.push(listener);
    },
    emit: (r) => {
      for (const l of listeners) l(r);
    },
    listenerCount: () => listeners.length,
  };
}

interface DepsOptions {
  loggedIn?: boolean;
  scripts?: Map<string, SectionScript>;
  /** Throw from assertPageSafe once this section URL has been reached. */
  blockOnSection?: string;
  blockCode?: 'CHECKPOINT_REQUIRED' | 'CIRCUIT_OPEN' | 'AUTH_REQUIRED';
  /** Throw from assertPageSafe even before the first navigation. */
  preflightBlock?: BrowserSafetyError;
}

function makeDeps(options: DepsOptions = {}): {
  deps: CaptureDeps;
  context: FakeContext;
  page: CapturePageLike;
  visited: string[];
  disposed: { value: boolean };
} {
  const context = makeContext();
  const visited: string[] = [];
  const disposed = { value: false };
  const page: CapturePageLike = {
    goto: vi.fn(async (url: string) => {
      visited.push(url);
      const script = options.scripts?.get(url);
      if (script?.navError) throw script.navError;
      for (const r of script?.requests ?? []) context.emit(r);
      return { status: 200 };
    }),
    waitForTimeout: vi.fn(async () => {}),
    mouse: { wheel: vi.fn(async () => {}) },
  };
  const deps: CaptureDeps = {
    ensureContext: vi.fn(async () => context),
    isLoggedIn: vi.fn(async () => options.loggedIn ?? true),
    getFeedPage: vi.fn(async () => page),
    assertPageSafe: vi.fn(async () => {
      if (options.preflightBlock) throw options.preflightBlock;
      if (options.blockOnSection && visited.includes(options.blockOnSection)) {
        throw new BrowserSafetyError(
          options.blockCode ?? 'CHECKPOINT_REQUIRED',
          'fixture safety stop',
        );
      }
    }),
    dispose: vi.fn(async () => {
      disposed.value = true;
    }),
  };
  return { deps, context, page, visited, disposed };
}

const sections = [
  { name: 'SECTION A', url: `${ORIGIN}/a/` },
  { name: 'SECTION B', url: `${ORIGIN}/b/` },
  { name: 'SECTION C', url: `${ORIGIN}/c/` },
];

// ── pure parsing helpers ────────────────────────────────────────────────────

it('parses voyager calls into catalog entries and ignores non-voyager traffic', () => {
  const entry = parseCapturedRequest(
    req(
      'GET',
      voyagerUrl('/graphql', {
        queryId: 'voyagerProfileDash123',
        decorationId: 'com.linkedin.Profile-45',
        variables: '(ids:List(1))',
      }),
    ),
  );
  expect(entry).toEqual({
    method: 'GET',
    path: '/graphql',
    queryId: 'voyagerProfileDash123',
    decorationId: 'com.linkedin.Profile-45',
    q: null,
    variables: '(ids:List(1))',
  });
  expect(parseCapturedRequest(req('GET', 'https://www.linkedin.com/feed/'))).toBeNull();
  expect(parseCapturedRequest(req('GET', 'http://%%%'))).toBeNull();
});

// ── 1. normal capture ───────────────────────────────────────────────────────

it('captures per-section calls, dedupes with counts, sorts by count desc and isolates buffers', async () => {
  const scripts = new Map<string, SectionScript>([
    [
      sections[0]!.url,
      {
        requests: [
          req('GET', voyagerUrl('/me')),
          req('GET', voyagerUrl('/me')),
          req('GET', voyagerUrl('/me')),
          req('POST', voyagerUrl('/graphql', { queryId: 'qid-a', variables: '(x:1)' })),
          req('GET', 'https://www.linkedin.com/feed/'), // ignored
        ],
      },
    ],
    [
      sections[1]!.url,
      {
        requests: [
          req('GET', voyagerUrl('/jobs', { q: 'search' })),
          req('GET', voyagerUrl('/jobs', { q: 'search' })),
        ],
      },
    ],
    [sections[2]!.url, { requests: [] }],
  ]);
  const { deps, context, disposed } = makeDeps({ scripts });
  const outcome = await runCaptureWithDeps(deps, { outputPath, sections });

  expect(outcome.ok).toBe(true);
  expect(outcome.reason).toBeUndefined();
  expect(disposed.value).toBe(true);
  expect(context.listenerCount()).toBe(1);
  expect(existsSync(outputPath)).toBe(true);

  const report = JSON.parse(readFileSync(outputPath, 'utf8'));
  expect(report.schemaVersion).toBe(1);
  expect(report.summary).toMatchObject({
    sectionsTotal: 3,
    sectionsVisited: 3,
    sectionsWithCapturedCalls: 2,
    stoppedEarly: false,
    stopReason: null,
    totalEntries: 3,
    notVisited: [],
  });

  const [a, b, c] = report.sections;
  expect(a.status).toBe('ok');
  // Count-desc ordering: /me seen 3x first, graphql 1x second.
  expect(a.entries.map((e: { path: string }) => e.path)).toEqual(['/me', '/graphql']);
  expect(a.entries[0]).toMatchObject({ method: 'GET', path: '/me', count: 3, queryId: null });
  expect(a.entries[1]).toMatchObject({
    method: 'POST',
    path: '/graphql',
    queryId: 'qid-a',
    decorationId: null,
    q: null,
    variables: '(x:1)',
    count: 1,
  });

  expect(b.status).toBe('ok');
  // Buffer isolation: section B must not contain section A's /me calls.
  expect(b.entries).toHaveLength(1);
  expect(b.entries[0]).toMatchObject({ path: '/jobs', q: 'search', count: 2 });

  expect(c.status).toBe('no_calls_captured');
  expect(c.entries).toEqual([]);
});

it('keeps distinct queryId/q combinations as separate entries', async () => {
  const scripts = new Map<string, SectionScript>([
    [
      sections[0]!.url,
      {
        requests: [
          req('GET', voyagerUrl('/graphql', { queryId: 'qid-1' })),
          req('GET', voyagerUrl('/graphql', { queryId: 'qid-2' })),
          req('GET', voyagerUrl('/rest', { q: 'hits' })),
          req('GET', voyagerUrl('/rest', { q: 'card' })),
        ],
      },
    ],
  ]);
  const { deps } = makeDeps({ scripts });
  const { report } = await executeCapture(deps, {
    sections: [sections[0]!],
    now: new Date('2026-11-13T00:00:00.000Z'),
  });
  expect(report.sections[0]!.entries).toHaveLength(4);
  expect(report.generatedAt).toBe('2026-11-13T00:00:00.000Z');
});

// ── 2. navigation failure ───────────────────────────────────────────────────

it('marks a section nav_failed and continues to remaining sections', async () => {
  const navError = new Error('net::ERR_ABORTED fixture timeout');
  const scripts = new Map<string, SectionScript>([
    // A thrown goto means the section's own requests never settle, so the
    // failed section legitimately captures nothing.
    [sections[0]!.url, { navError }],
    [sections[1]!.url, { requests: [req('GET', voyagerUrl('/jobs'))] }],
  ]);
  const { deps, visited } = makeDeps({ scripts });
  const outcome = await runCaptureWithDeps(deps, { outputPath, sections });

  expect(outcome.ok).toBe(true); // later sections still captured calls
  const report = outcome.report!;
  const [a, b, c] = report.sections;
  expect(a.status).toBe('nav_failed');
  expect(a.error).toContain('ERR_ABORTED');
  expect(a.entries).toEqual([]);
  expect(b.status).toBe('ok');
  expect(c.status).toBe('no_calls_captured');
  // The run did not stop: every section URL was visited.
  expect(visited).toEqual(sections.map((s) => s.url));
  expect(report.summary.stoppedEarly).toBe(false);
});

it('retains calls captured before a post-navigation safety inspection fails', async () => {
  // Section A succeeds; section B fires calls, then the post-navigation
  // inspection detects a challenge on the rendered page.
  const scripts = new Map<string, SectionScript>([
    [sections[0]!.url, { requests: [req('GET', voyagerUrl('/me'))] }],
    [sections[1]!.url, { requests: [req('GET', voyagerUrl('/jobs'))] }],
  ]);
  const { deps, visited } = makeDeps({
    scripts,
    blockOnSection: sections[1]!.url,
    blockCode: 'CHECKPOINT_REQUIRED',
  });
  const outcome = await runCaptureWithDeps(deps, { outputPath, sections });
  const [a, b] = outcome.report!.sections;
  expect(a.status).toBe('ok');
  expect(b.status).toBe('blocked_by_safety');
  expect(b.safetyCode).toBe('CHECKPOINT_REQUIRED');
  expect(b.entries).toHaveLength(1);
  expect(b.entries[0]).toMatchObject({ path: '/jobs' });
  expect(visited).not.toContain(sections[2]!.url);
});

// ── 3. security interception ────────────────────────────────────────────────

it.each(['CHECKPOINT_REQUIRED', 'CIRCUIT_OPEN'] as const)(
  'marks %s as blocked_by_safety and stops navigating to remaining sections',
  async (code) => {
    const scripts = new Map<string, SectionScript>([
      [sections[0]!.url, { requests: [req('GET', voyagerUrl('/me'))] }],
      [sections[1]!.url, { requests: [req('GET', voyagerUrl('/jobs'))] }],
    ]);
    const { deps, visited } = makeDeps({
      scripts,
      blockOnSection: sections[1]!.url,
      blockCode: code,
    });
    const outcome = await runCaptureWithDeps(deps, { outputPath, sections });

    // One section had captured calls before the block → exit code stays 0.
    expect(outcome.ok).toBe(true);
    const report = outcome.report!;
    expect(report.summary.stoppedEarly).toBe(true);
    expect(report.summary.stopReason).toBe(code);
    expect(report.summary.sectionsVisited).toBe(2);
    expect(report.summary.notVisited).toEqual([{ name: sections[2]!.name, url: sections[2]!.url }]);

    const [a, b] = report.sections;
    expect(a.status).toBe('ok');
    expect(b.status).toBe('blocked_by_safety');
    expect(b.safetyCode).toBe(code);
    expect(b.error).toBeTruthy();
    // The remaining section was never navigated to.
    expect(visited).not.toContain(sections[2]!.url);
    // Already-captured results were still written to disk.
    expect(existsSync(outputPath)).toBe(true);
    expect(JSON.parse(readFileSync(outputPath, 'utf8')).sections).toHaveLength(2);
  },
);

it('treats a safety error thrown by goto itself as a block and still writes the catalog', async () => {
  const challenge = new BrowserSafetyError('CHECKPOINT_REQUIRED', 'fixture challenge during goto');
  const scripts = new Map<string, SectionScript>([
    [sections[0]!.url, { requests: [req('GET', voyagerUrl('/me'))] }],
    [sections[1]!.url, { navError: challenge }],
  ]);
  const { deps, visited } = makeDeps({ scripts });
  const outcome = await runCaptureWithDeps(deps, { outputPath, sections });

  expect(outcome.ok).toBe(true);
  const [a, b] = outcome.report!.sections;
  expect(a.status).toBe('ok');
  expect(b).toMatchObject({ status: 'blocked_by_safety', safetyCode: 'CHECKPOINT_REQUIRED' });
  expect(visited).not.toContain(sections[2]!.url);
  expect(existsSync(outputPath)).toBe(true);
});

it('stops before any navigation when the circuit is already open', async () => {
  const { deps, visited } = makeDeps({
    preflightBlock: new BrowserSafetyError('CIRCUIT_OPEN', 'fixture pre-existing stop'),
  });
  const outcome = await runCaptureWithDeps(deps, { outputPath, sections });

  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toBe('NO_CALLS_CAPTURED');
  expect(visited).toEqual([]);
  expect(outcome.report!.sections[0]).toMatchObject({
    name: sections[0]!.name,
    status: 'blocked_by_safety',
    safetyCode: 'CIRCUIT_OPEN',
  });
  expect(outcome.report!.summary.notVisited).toHaveLength(2);
  expect(existsSync(outputPath)).toBe(true);
});

// ── 4. all-empty result ─────────────────────────────────────────────────────

it('exits unsuccessfully with NO_CALLS_CAPTURED when every section comes up empty', async () => {
  const { deps } = makeDeps({ scripts: new Map() });
  const outcome = await runCaptureWithDeps(deps, { outputPath, sections });

  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toBe('NO_CALLS_CAPTURED');
  // The catalog is still written so the empty run itself is auditable.
  expect(existsSync(outputPath)).toBe(true);
  const report = JSON.parse(readFileSync(outputPath, 'utf8'));
  expect(report.summary.sectionsWithCapturedCalls).toBe(0);
  expect(report.sections.every((s: { status: string }) => s.status === 'no_calls_captured')).toBe(
    true,
  );
});

it('does not run sections or write a catalog when the session is not logged in', async () => {
  const { deps, visited } = makeDeps({ loggedIn: false });
  const outcome = await runCaptureWithDeps(deps, { outputPath, sections });

  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toBe('NOT_LOGGED_IN');
  expect(visited).toEqual([]);
  expect(existsSync(outputPath)).toBe(false);
});

/** A path the OS cannot create (unmounted drive on Windows, /dev/null-as-dir elsewhere). */
function unwritablePath(): string {
  return process.platform === 'win32'
    ? 'Z:/nonexistent-drive/catalog.json'
    : '/dev/null/catalog.json';
}

// ── write failure must not look like success ────────────────────────────────

it('reports REPORT_WRITE_FAILED instead of success when the catalog cannot be written', async () => {
  const scripts = new Map<string, SectionScript>([
    [sections[0]!.url, { requests: [req('GET', voyagerUrl('/me'))] }],
  ]);
  const { deps } = makeDeps({ scripts });
  const outcome = await runCaptureWithDeps(deps, { outputPath: unwritablePath(), sections });

  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toBe('REPORT_WRITE_FAILED');
  expect(outcome.writeError).toBeTruthy();
  expect(outcome.report).toBeDefined(); // evidence gathered, persistence failed
});

it('writeCaptureReport surfaces I/O errors to the caller', () => {
  const report = buildCaptureReport([], [], false, null, new Date('2026-11-13T00:00:00.000Z'));
  expect(() => writeCaptureReport(report, unwritablePath())).toThrow();
});

// ── exported section plan sanity ────────────────────────────────────────────

it('ships the full section plan covering profile, search, jobs, company, messaging and notifications', () => {
  const names = CAPTURE_SECTIONS.map((s) => s.name);
  expect(names).toEqual(
    expect.arrayContaining([
      'PROFILE EXPERIENCE',
      'PEOPLE SEARCH',
      'JOBS SEARCH',
      'COMPANY',
      'MESSAGING',
      'NOTIFICATIONS',
    ]),
  );
  expect(CAPTURE_SECTIONS.every((s) => s.url.startsWith('https://www.linkedin.com/'))).toBe(true);
});

/**
 * Endpoint capture tool (`--capture`).
 *
 * The architecture is proven: in-page Voyager fetch returns JSON. But Voyager's
 * REST-li paths get deprecated (HTTP 410) and its GraphQL queryIds rotate, so
 * they cannot be hardcoded long-term — they must be observed from the live SPA.
 *
 * This drives the authenticated browser through the main sections (profile,
 * people search, jobs, companies, messaging, notifications) and records every
 * `/voyager/api/...` request the page itself fires. The result is written to a
 * JSON catalog file that is the ground-truth endpoint source to wire into
 * endpoints.ts.
 *
 * The catalog records a per-section status so a run is auditable afterwards:
 *   - ok                   : the section loaded and at least one call was seen
 *   - nav_failed           : navigation threw, but no safety block was detected
 *   - blocked_by_safety    : a checkpoint/challenge or an open circuit stopped
 *                            the section; no further section is visited
 *   - no_calls_captured    : the section loaded but fired no Voyager calls
 *
 * Per-section buffers are reset before every navigation, so calls from one
 * section can never be counted in the next. A safety block aborts the remaining
 * sections, but every section already captured is still written to the file.
 * The process exits non-zero only when not a single section captured a call.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BrowserEngine } from './engine.js';
import { BrowserSafetyError } from './safety.js';
import type { Logger } from '../types.js';
import type { EnvConfig } from '../config/env.js';
import type { Page } from 'patchright';

const ORIGIN = 'https://www.linkedin.com';
const VOYAGER_MARKER = '/voyager/api/';
const NAV_TIMEOUT_MS = 30000;
const SETTLE_MS = 3500;
const LAZY_SCROLL_MS = 2000;
const REPORT_SCHEMA_VERSION = 1;

/** Per-section outcome recorded in the catalog. */
export type SectionStatus = 'ok' | 'nav_failed' | 'blocked_by_safety' | 'no_calls_captured';

/** One deduped Voyager call observed inside a single section. */
export interface CapturedCallEntry {
  method: string;
  /** Pathname after `/voyager/api`. */
  path: string;
  queryId: string | null;
  decorationId: string | null;
  q: string | null;
  /** Raw (still URL-encoded) GraphQL variables literal, when present. */
  variables: string | null;
  /** Number of times the exact same call was seen in this section. */
  count: number;
}

/** Catalog record for one visited section. */
export interface CaptureSectionResult {
  name: string;
  url: string;
  status: SectionStatus;
  /** Present for `nav_failed` / `blocked_by_safety`; bounded error text. */
  error?: string;
  /** Present for `blocked_by_safety` (e.g. CHECKPOINT_REQUIRED, CIRCUIT_OPEN). */
  safetyCode?: string;
  entries: CapturedCallEntry[];
}

/** The full catalog document written to disk. */
export interface CaptureReport {
  schemaVersion: number;
  generatedAt: string;
  origin: string;
  summary: {
    sectionsTotal: number;
    sectionsVisited: number;
    sectionsWithCapturedCalls: number;
    /** True when a safety block stopped the run before all sections ran. */
    stoppedEarly: boolean;
    stopReason: string | null;
    /** Sections never visited because the run stopped early. */
    notVisited: { name: string; url: string }[];
    totalEntries: number;
  };
  sections: CaptureSectionResult[];
}

/** Result of a capture run, including the exit contract for the CLI. */
export interface CaptureOutcome {
  /** True when at least one section captured at least one Voyager call. */
  ok: boolean;
  /** Machine-readable reason when {@link ok} is false. */
  reason?: 'NOT_LOGGED_IN' | 'NO_CALLS_CAPTURED' | 'REPORT_WRITE_FAILED' | 'BROWSER_SETUP_FAILED';
  report?: CaptureReport;
  outputPath?: string;
  /** Present when writing the catalog failed; the run is not a success. */
  writeError?: string;
}

/** Minimal shape of a page request the listener needs. */
export interface CaptureRequestLike {
  url(): string;
  method(): string;
}

/** Minimal page surface used by the capture flow (real patchright Page satisfies it). */
export interface CapturePageLike {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  mouse: { wheel(dx: number, dy: number): Promise<unknown> };
}

/** Minimal context surface: request events only. */
export interface CaptureContextLike {
  on(event: 'request', listener: (req: CaptureRequestLike) => void): void;
}

/**
 * Everything the orchestration needs, expressed as an interface so the whole
 * flow is testable with local fakes — no real browser, no real LinkedIn.
 */
export interface CaptureDeps {
  ensureContext(): Promise<CaptureContextLike>;
  isLoggedIn(): Promise<boolean>;
  getFeedPage(): Promise<CapturePageLike>;
  /** Challenge / circuit inspection. Optional: a null safety layer passes. */
  assertPageSafe?(page: CapturePageLike): Promise<void>;
  dispose(): Promise<void>;
}

export const CAPTURE_SECTIONS: { name: string; url: string }[] = [
  { name: 'PROFILE EXPERIENCE', url: `${ORIGIN}/in/me/details/experience/` },
  { name: 'PROFILE EDUCATION', url: `${ORIGIN}/in/me/details/education/` },
  { name: 'PROFILE SKILLS', url: `${ORIGIN}/in/me/details/skills/` },
  { name: 'PEOPLE SEARCH', url: `${ORIGIN}/search/results/people/?keywords=engineer` },
  { name: 'JOBS SEARCH', url: `${ORIGIN}/jobs/search/?keywords=software%20engineer` },
  { name: 'COMPANY', url: `${ORIGIN}/company/microsoft/` },
  { name: 'MESSAGING', url: `${ORIGIN}/messaging/` },
  { name: 'NOTIFICATIONS', url: `${ORIGIN}/notifications/` },
];

/** Default catalog location (relative to the process working directory). */
export const DEFAULT_CAPTURE_OUTPUT = 'voyager-capture.json';

/**
 * Parse one observed request into a dedupable catalog entry. Returns null when
 * the request is not a Voyager API call or its URL cannot be parsed.
 */
export function parseCapturedRequest(
  req: CaptureRequestLike,
): Omit<CapturedCallEntry, 'count'> | null {
  const url = req.url();
  if (!url.includes(VOYAGER_MARKER)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return {
    method: req.method(),
    path: u.pathname.slice(VOYAGER_MARKER.length - 1),
    queryId: u.searchParams.get('queryId'),
    decorationId: u.searchParams.get('decorationId'),
    q: u.searchParams.get('q'),
    variables: u.searchParams.get('variables'),
  };
}

/**
 * Fold one parsed request into the current section's dedup buffer. Keyed by
 * method + path + queryId + q so distinct GraphQL operations stay separate.
 */
function recordRequest(buffer: Map<string, CapturedCallEntry>, req: CaptureRequestLike): void {
  const parsed = parseCapturedRequest(req);
  if (!parsed) return;
  const key = `${parsed.method} ${parsed.path} ${parsed.queryId ?? ''} ${parsed.q ?? ''}`;
  const existing = buffer.get(key);
  if (existing) {
    existing.count += 1;
  } else {
    buffer.set(key, { ...parsed, count: 1 });
  }
}

function isSafetyBlock(err: unknown): err is BrowserSafetyError {
  return err instanceof BrowserSafetyError;
}

function boundedMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

/** Sort entries by occurrence count descending, with a stable tiebreaker. */
function sortEntries(buffer: Map<string, CapturedCallEntry>): CapturedCallEntry[] {
  return [...buffer.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.method < b.method ? -1 : a.method > b.method ? 1 : 0;
  });
}

/**
 * Build the catalog document from the visited section results and the original
 * section plan (so unvisited sections can be listed explicitly).
 */
export function buildCaptureReport(
  sections: CaptureSectionResult[],
  plan: { name: string; url: string }[],
  stoppedEarly: boolean,
  stopReason: string | null,
  now: Date,
): CaptureReport {
  const visitedNames = new Set(sections.map((s) => s.name));
  const notVisited = plan.filter((s) => !visitedNames.has(s.name));
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    origin: ORIGIN,
    summary: {
      sectionsTotal: plan.length,
      sectionsVisited: sections.length,
      sectionsWithCapturedCalls: sections.filter((s) => s.entries.length > 0).length,
      stoppedEarly,
      stopReason,
      notVisited,
      totalEntries: sections.reduce((sum, s) => sum + s.entries.length, 0),
    },
    sections,
  };
}

/**
 * Persist the catalog as pretty-printed JSON. Throws on any I/O failure so the
 * caller can fail the command instead of claiming a successful capture.
 */
export function writeCaptureReport(report: CaptureReport, outputPath: string): void {
  mkdirSync(dirname(outputPath) || '.', { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8' });
}

/**
 * Drive the sections and build the in-memory catalog. All browser interaction
 * goes through {@link deps}, so this function never touches patchright directly
 * and is fully exercisable with fakes.
 */
export async function executeCapture(
  deps: CaptureDeps,
  options: { sections?: { name: string; url: string }[]; now?: Date } = {},
): Promise<{ report: CaptureReport; stoppedEarly: boolean; stopReason: string | null }> {
  const sections = options.sections ?? CAPTURE_SECTIONS;
  // One buffer per section. It is replaced before every navigation, which is
  // what guarantees calls cannot leak across sections.
  let buffer = new Map<string, CapturedCallEntry>();
  const context = await deps.ensureContext();
  context.on('request', (req) => recordRequest(buffer, req));

  const page = await deps.getFeedPage();
  const results: CaptureSectionResult[] = [];
  let stoppedEarly = false;
  let stopReason: string | null = null;

  for (const section of sections) {
    // Fresh buffer for this section only — the previous section's buffer is
    // replaced before any navigation, so its calls can never leak into this one.
    buffer = new Map<string, CapturedCallEntry>();
    process.stderr.write(`\n\n========== ${section.name} ==========\n${section.url}\n`);
    const result: CaptureSectionResult = {
      name: section.name,
      url: section.url,
      status: 'no_calls_captured',
      entries: [],
    };

    const finalizeBlocked = (err: BrowserSafetyError): void => {
      // Keep whatever this section captured before the block, then stop.
      result.entries = sortEntries(buffer);
      result.status = 'blocked_by_safety';
      result.safetyCode = err.code;
      result.error = boundedMessage(err);
      stoppedEarly = true;
      stopReason = err.code;
      results.push(result);
    };

    // An already-open circuit (e.g. tripped by an earlier hard signal) blocks
    // before any further navigation is attempted.
    try {
      await deps.assertPageSafe?.(page);
    } catch (err) {
      if (isSafetyBlock(err)) {
        finalizeBlocked(err);
        break;
      }
      throw err;
    }

    try {
      await page.goto(section.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      // Let the SPA fire its data calls; scroll to trigger lazy loads.
      await page.waitForTimeout(SETTLE_MS);
      await page.mouse.wheel(0, 2000).catch(() => {});
      await page.waitForTimeout(LAZY_SCROLL_MS);
    } catch (err) {
      // A challenge navigation can surface as a thrown goto: classify it as a
      // safety block, not a generic navigation failure.
      if (isSafetyBlock(err)) {
        finalizeBlocked(err);
        break;
      }
      result.status = 'nav_failed';
      result.error = boundedMessage(err);
      process.stderr.write(`  (nav warning: ${result.error})\n`);
    }

    // Post-navigation inspection: challenge page or tripped breaker after a
    // goto that technically resolved.
    if (result.status !== 'blocked_by_safety') {
      try {
        await deps.assertPageSafe?.(page);
      } catch (err) {
        if (isSafetyBlock(err)) {
          finalizeBlocked(err);
          break;
        }
        result.status = 'nav_failed';
        result.error = boundedMessage(err);
      }
    }

    result.entries = sortEntries(buffer);
    // A navigation failure keeps its status even when partial calls arrived;
    // otherwise entries present means success, absent means none captured.
    if (result.status === 'no_calls_captured') {
      result.status = result.entries.length > 0 ? 'ok' : 'no_calls_captured';
    }
    if (!result.entries.length && result.status === 'no_calls_captured') {
      process.stderr.write('  (no voyager calls captured)\n');
    }
    for (const r of result.entries) {
      const tag = r.queryId
        ? `GRAPHQL queryId=${r.queryId}`
        : `REST-li${r.q ? ` q=${r.q}` : ''}${r.decorationId ? ` deco=${r.decorationId}` : ''}`;
      process.stderr.write(`  [${r.count}x] ${r.method} ${r.path}  ::  ${tag}\n`);
      if (r.variables) {
        const v = r.variables.length > 240 ? r.variables.slice(0, 240) + '…' : r.variables;
        process.stderr.write(`           variables=${v}\n`);
      }
    }
    results.push(result);
  }

  const report = buildCaptureReport(
    results,
    sections,
    stoppedEarly,
    stopReason,
    options.now ?? new Date(),
  );
  return { report, stoppedEarly, stopReason };
}

/**
 * Full CLI capture: run the sections, write the catalog, and translate the
 * outcome into the process exit contract. A write failure is reported as a
 * failure — never as a successful capture.
 */
export async function runCaptureWithDeps(
  deps: CaptureDeps,
  options: { outputPath: string; sections?: { name: string; url: string }[]; now?: Date },
): Promise<CaptureOutcome> {
  try {
    if (!(await deps.isLoggedIn())) {
      process.stderr.write('\n❌ Not logged in. Run `npm run login` first.\n');
      return { ok: false, reason: 'NOT_LOGGED_IN' };
    }

    const { report } = await executeCapture(deps, { sections: options.sections, now: options.now });
    try {
      writeCaptureReport(report, options.outputPath);
    } catch (err) {
      process.stderr.write(
        `\n❌ Failed to write capture catalog to ${options.outputPath}: ${boundedMessage(err)}\n`,
      );
      return {
        ok: false,
        reason: 'REPORT_WRITE_FAILED',
        report,
        outputPath: options.outputPath,
        writeError: boundedMessage(err),
      };
    }

    const anyCaptured = report.summary.sectionsWithCapturedCalls > 0;
    if (anyCaptured) {
      process.stderr.write(
        `\n\n✅ Capture complete — catalog written to ${options.outputPath} ` +
          `(${report.summary.sectionsWithCapturedCalls}/${report.summary.sectionsVisited} sections captured calls).\n`,
      );
      return { ok: true, report, outputPath: options.outputPath };
    }
    process.stderr.write(
      '\n❌ Capture finished but no section captured any /voyager/api calls; ' +
        'the catalog cannot be considered complete.\n',
    );
    return { ok: false, reason: 'NO_CALLS_CAPTURED', report, outputPath: options.outputPath };
  } catch (err) {
    process.stderr.write(`\n❌ Capture failed: ${boundedMessage(err)}\n`);
    return { ok: false, reason: 'BROWSER_SETUP_FAILED', writeError: boundedMessage(err) };
  } finally {
    await deps.dispose().catch(() => {});
  }
}

/** CLI entry point: wire {@link CaptureDeps} onto the real {@link BrowserEngine}. */
export async function runCapture(
  config: EnvConfig,
  logger: Logger,
  outputPath = process.env.LINKEDIN_CAPTURE_OUT || DEFAULT_CAPTURE_OUTPUT,
): Promise<CaptureOutcome> {
  const engine = new BrowserEngine({ ...config, LINKEDIN_HEADLESS: false }, logger);
  const deps: CaptureDeps = {
    ensureContext: () => engine.ensureContext() as Promise<CaptureContextLike>,
    isLoggedIn: () => engine.isLoggedIn(),
    getFeedPage: () => engine.getFeedPage() as Promise<CapturePageLike>,
    assertPageSafe: (page) => engine.assertPageSafe(page as Page),
    dispose: () => engine.dispose(),
  };
  return runCaptureWithDeps(deps, { outputPath });
}

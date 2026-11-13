import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import type { CrawlResult } from '../types/graph';

let dbModule: typeof import('../lib/db');
let tempDir: string;
let dbPath: string;

function makeResult(seedId = 'Test Page'): CrawlResult {
  return {
    id: `test-${seedId}`,
    seedId,
    nodes: [
      {
        id: seedId,
        title: seedId,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(seedId)}`,
        depth: 0,
        inDegree: 0,
        outDegree: 0,
        pagerank: 1,
        betweenness: 0,
        communityId: 0,
      },
    ],
    edges: [],
    communities: [],
    crawledAt: new Date().toISOString(),
    positions: {},
  };
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wikicrawl-db-test-'));
  dbPath = path.join(tempDir, 'test.db');

  process.env.WIKICRAWL_DB_PATH = dbPath;

  // Ensure lib/db.ts reads our temporary database path.
  const previousModule = await import('../lib/db');
  dbModule = previousModule;
});

afterAll(() => {
  delete process.env.WIKICRAWL_DB_PATH;

  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('crawl result SQLite cache', () => {
  it('returns a fresh cached result', () => {
    const key = `fresh-${Date.now()}`;
    const result = makeResult();

    dbModule.setCachedResult(key, 'Test Page', 2, 150, result);

    expect(dbModule.getCachedResult(key)).toEqual(result);
  });

  it('treats an expired SQLite result as a cache miss', () => {
    const key = `expired-${Date.now()}`;
    const result = makeResult();

    dbModule.setCachedResult(key, 'Expired Page', 2, 150, result);

    const sqlite = new BetterSqlite3(dbPath);

    sqlite
      .prepare(
        'UPDATE crawl_cache SET created_at = ? WHERE id = ?'
      )
      .run(
        new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        key
      );

    sqlite.close();

    expect(dbModule.getCachedResult(key)).toBeNull();
  });

  it('treats an invalid created_at timestamp as a cache miss', () => {
    const key = `invalid-${Date.now()}`;
    const result = makeResult();

    dbModule.setCachedResult(key, 'Invalid Timestamp Page', 2, 150, result);

    const sqlite = new BetterSqlite3(dbPath);

    sqlite
      .prepare(
        'UPDATE crawl_cache SET created_at = ? WHERE id = ?'
      )
      .run('not-a-real-timestamp', key);

    sqlite.close();

    expect(dbModule.getCachedResult(key)).toBeNull();
  });

  it('deletes an expired row after detecting it', () => {
    const key = `delete-expired-${Date.now()}`;
    const result = makeResult();

    dbModule.setCachedResult(key, 'Delete Expired', 2, 150, result);

    const sqlite = new BetterSqlite3(dbPath);

    sqlite
      .prepare(
        'UPDATE crawl_cache SET created_at = ? WHERE id = ?'
      )
      .run(
        new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        key
      );

    sqlite.close();

    expect(dbModule.getCachedResult(key)).toBeNull();

    const verificationDb = new BetterSqlite3(dbPath);

    const row = verificationDb
      .prepare(
        'SELECT id FROM crawl_cache WHERE id = ?'
      )
      .get(key);

    verificationDb.close();

    expect(row).toBeUndefined();
  });
});
/**
 * Unit tests for the catalog collection summary. They run on node's
 * built-in test runner with no browser involved:
 *
 *   npm test
 *
 * Covered: a normal multi-page collection, an empty first page,
 * duplicate rows across pages, and an interrupted collection whose
 * retry must not insert a row twice.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CatalogItem } from '../api/gateways.ts';
import {
  CatalogCollectionAccumulator,
  catalogItemKey,
  summarizeCatalogCollection,
  type CatalogPageInput,
} from './catalogCollection.ts';

let seq = 0;

function item(
  connector: string,
  target: string,
  extra: Partial<CatalogItem> = {},
): CatalogItem {
  seq += 1;
  return {
    gateway_id: 'gw-1',
    connector_uuid: connector,
    connector_id: 'argocd-main',
    target_id: target,
    source: 'discovered',
    status: 'present',
    first_seen_at: `2026-01-01T00:00:0${seq}Z`,
    is_new: false,
    look_alike: false,
    binding_count: 0,
    ...extra,
  };
}

function page(items: CatalogItem[], nextCursor?: string): CatalogPageInput {
  return { items, next_cursor: nextCursor };
}

test('a normal multi-page collection counts every row and ends complete', () => {
  const pages = [
    page([item('c1', 't-a'), item('c1', 't-b')], 'cursor-1'),
    page([item('c1', 't-c')], 'cursor-2'),
    page([item('c2', 't-a')]),
  ];

  const summary = summarizeCatalogCollection(pages);

  assert.equal(summary.complete, true);
  assert.equal(summary.interruptionReason, null);
  assert.equal(summary.failure, null);
  assert.equal(summary.loadedPages, 3);
  assert.equal(summary.totalCount, 4);
  assert.equal(summary.uniqueCount, 4);
  assert.equal(summary.duplicateCount, 0);
  assert.equal(summary.nextCursor, null);
  // First-seen order is preserved.
  assert.deepEqual(summary.items.map(catalogItemKey), [
    'c1/t-a',
    'c1/t-b',
    'c1/t-c',
    'c2/t-a',
  ]);
});

test('an empty first page is a complete, empty collection', () => {
  const summary = summarizeCatalogCollection([page([])]);

  assert.equal(summary.complete, true);
  assert.equal(summary.interruptionReason, null);
  assert.equal(summary.totalCount, 0);
  assert.equal(summary.uniqueCount, 0);
  assert.equal(summary.duplicateCount, 0);
  assert.deepEqual(summary.items, []);
});

test('an empty page in the middle still pages on and a later empty tail ends it', () => {
  const pages = [
    page([item('c1', 't-a')], 'cursor-1'),
    page([], 'cursor-2'),
    page([]),
  ];
  const summary = summarizeCatalogCollection(pages);

  assert.equal(summary.complete, true);
  assert.equal(summary.loadedPages, 3);
  assert.equal(summary.uniqueCount, 1);
  assert.equal(summary.totalCount, 1);
});

test('duplicate entries are counted once and reported as duplicates', () => {
  const shared = item('c1', 't-shared');
  const pages = [
    page([shared, item('c1', 't-b')], 'cursor-1'),
    page([shared, item('c1', 't-c')], 'cursor-2'),
    // Same target on another connector is a different row, not a duplicate.
    page([item('c2', 't-shared')]),
  ];

  const summary = summarizeCatalogCollection(pages);

  assert.equal(summary.complete, true);
  assert.equal(summary.totalCount, 5);
  assert.equal(summary.uniqueCount, 4);
  assert.equal(summary.duplicateCount, 1);
  assert.equal(
    summary.items.filter((it) => catalogItemKey(it) === 'c1/t-shared').length,
    1,
  );
  assert.deepEqual(summary.items.map(catalogItemKey), [
    'c1/t-shared',
    'c1/t-b',
    'c1/t-c',
    'c2/t-shared',
  ]);
});

test('an interrupted page keeps the loaded rows, says why, and a retry never duplicates', () => {
  const acc = new CatalogCollectionAccumulator();
  const first = [item('c1', 't-a'), item('c1', 't-b')];
  acc.appendPage(page(first, 'cursor-1'));

  // Page two fails. Everything already loaded must survive, and the
  // collection must not call itself complete.
  acc.recordFailure(new Error('HTTP 502'));
  const broken = acc.summary;
  assert.equal(broken.complete, false);
  assert.equal(broken.interruptionReason, 'page_failed');
  assert.deepEqual(broken.failure, { page: 2, reason: 'HTTP 502' });
  assert.equal(broken.uniqueCount, 2);
  assert.equal(broken.totalCount, 2);
  assert.equal(broken.nextCursor, 'cursor-1');

  // The retry returns the same rows the failed request would have, plus
  // a fresh one. The overlap is deduped and the collection then ends.
  acc.appendPage(page([...first, item('c1', 't-c')]));
  const recovered = acc.summary;
  assert.equal(recovered.complete, true);
  assert.equal(recovered.interruptionReason, null);
  assert.equal(recovered.failure, null);
  assert.equal(recovered.totalCount, 5);
  assert.equal(recovered.uniqueCount, 3);
  assert.equal(recovered.duplicateCount, 2);
  assert.deepEqual(recovered.items.map(catalogItemKey), [
    'c1/t-a',
    'c1/t-b',
    'c1/t-c',
  ]);
});

test('a first-page failure reports the interruption with no rows invented', () => {
  const acc = new CatalogCollectionAccumulator();
  acc.recordFailure('Network error.');
  const summary = acc.summary;

  assert.equal(summary.complete, false);
  assert.equal(summary.interruptionReason, 'page_failed');
  assert.equal(summary.loadedPages, 0);
  assert.equal(summary.uniqueCount, 0);
  assert.deepEqual(summary.failure, { page: 1, reason: 'Network error.' });
});

test('a lost cursor is distinguished from a plain failed page', () => {
  const acc = new CatalogCollectionAccumulator();
  acc.appendPage(page([item('c1', 't-a')], 'cursor-1'));
  acc.recordFailure(new Error('HTTP 500'), { cursorLost: true });

  const summary = acc.summary;
  assert.equal(summary.complete, false);
  assert.equal(summary.interruptionReason, 'cursor_lost');
  assert.equal(summary.nextCursor, null);
  assert.equal(summary.uniqueCount, 1);
});

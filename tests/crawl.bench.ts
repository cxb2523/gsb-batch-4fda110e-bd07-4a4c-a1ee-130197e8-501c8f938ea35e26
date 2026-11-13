import { afterAll, bench, describe, vi } from 'vitest';
import { installMockMediaWiki } from './helpers/mockMediaWiki';

vi.mock('../lib/db', () => ({
  getCachedPageLinks: vi.fn(() => null),
  setCachedPageLinks: vi.fn(),
  getCachedPageViews: vi.fn(() => null),
  setCachedPageViews: vi.fn(),
  getCachedRelationship: vi.fn(() => null),
  setCachedRelationship: vi.fn(),
}));

import { buildGraph, crawlWikipedia } from '../lib/crawler';
import { analyzeGraph } from '../lib/graphAnalysis';

interface BenchmarkRow {
  scenario: string;
  'API requests': number;
  'pageview requests': number;
  'link rows downloaded': number;
  nodes: number;
  edges: number;
  'depth histogram': string;
  'crawl CPU ms': number;
  'analyzeGraph ms': number;
  'estimated wall time @ 200ms RTT': string;
}

const rows: BenchmarkRow[] = [];

async function runScenario(scenario: string, depth: number, maxNodes: number, pageviewLatencyMs = 0): Promise<void> {
  const mock = installMockMediaWiki({ pageviewLatencyMs });
  try {
    const crawlStart = performance.now();
    const result = await crawlWikipedia({ seedTitle: 'Page 0', depth, maxNodes });
    const crawlMs = performance.now() - crawlStart;
    const graph = buildGraph(result.nodes, result.edges);
    const analysisStart = performance.now();
    analyzeGraph(graph, result.seedId);
    const analysisMs = performance.now() - analysisStart;
    const depths = new Map<number, number>();
    for (const node of result.nodes) depths.set(node.depth, (depths.get(node.depth) ?? 0) + 1);
    const histogram = [...depths.entries()].sort(([left], [right]) => left - right)
      .map(([depthValue, count]) => `${depthValue}:${count}`).join(', ');

    rows.push({
      scenario,
      'API requests': mock.stats.requests,
      'pageview requests': mock.stats.pageviewRequests,
      'link rows downloaded': mock.stats.linkRowsDownloaded,
      nodes: result.nodes.length,
      edges: result.edges.length,
      'depth histogram': histogram,
      'crawl CPU ms': Number(crawlMs.toFixed(2)),
      'analyzeGraph ms': Number(analysisMs.toFixed(2)),
      'estimated wall time @ 200ms RTT': `${(mock.stats.requests * 0.2).toFixed(2)}s`,
    });
  } finally {
    mock.restore();
  }
}

describe('crawl benchmark', () => {
  bench('default and two-hop crawl scenarios', async () => {
    if (rows.length === 0) {
      await runScenario('default depth=3 maxNodes=500', 3, 500);
      await runScenario('default depth=2 maxNodes=150', 2, 150);
      await runScenario('ranked depth=2 maxNodes=150 @ 200ms pageviews', 2, 150, 200);
    }
  }, { iterations: 1, warmupIterations: 0 });
});

afterAll(() => {
  console.table(rows);
});
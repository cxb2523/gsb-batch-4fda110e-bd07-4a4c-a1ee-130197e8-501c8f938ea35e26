import { describe, expect, it } from 'vitest';
import { loadExploreGraph, validateExploreGraph, type ExploreGraphData } from './exploreData';
import { exploreTopics, getExploreTopic } from './exploreTopics';
import type { WikiNode } from '@/types/graph';

const topic = getExploreTopic('black-holes')!;
const seed: WikiNode = {
  id: 'Black hole',
  title: 'Black hole',
  url: 'https://en.wikipedia.org/wiki/Black_hole',
  depth: 0,
  inDegree: 0,
  outDegree: 1,
  pagerank: 0.5,
  betweenness: 0,
  communityId: 0,
};
const related: WikiNode = {
  ...seed,
  id: 'Event horizon',
  title: 'Event horizon',
  url: 'https://en.wikipedia.org/wiki/Event_horizon',
  depth: 1,
};
const validGraph: ExploreGraphData = {
  schemaVersion: 1,
  seedTitle: 'Black hole',
  seedId: seed.id,
  nodes: [seed, related],
  edges: [{ source: seed.id, target: related.id }],
  partial: false,
  failedTitles: [],
};

describe('precomputed explore graph validation', () => {
  it('accepts graph nodes and edges with a matching curated seed', () => {
    expect(validateExploreGraph(validGraph, topic)).toEqual([]);
  });

  it('accepts a valid sample with no internal edges', () => {
    expect(validateExploreGraph({ ...validGraph, edges: [] }, topic)).toEqual([]);
  });

  it('rejects missing seeds, duplicate IDs, invalid metrics, and dangling edges', () => {
    const invalid = {
      ...validGraph,
      nodes: [seed, { ...related, id: seed.id, pagerank: Number.NaN }],
      edges: [{ source: seed.id, target: 'Missing page' }],
    };
    const issues = validateExploreGraph(invalid, topic);
    expect(issues).toContain('Graph contains duplicate node ID Black hole.');
    expect(issues).toContain('Graph node Black hole has invalid metrics.');
    expect(issues).toContain('Edge Black hole -> Missing page references a missing node.');
  });

  it('rejects a dataset for a different topic', () => {
    expect(validateExploreGraph({ ...validGraph, seedTitle: 'Artificial intelligence' }, topic))
      .toContain('Graph seed title does not match the curated Wikipedia title for black-holes.');
  });

  it('loads and validates every checked-in curated dataset', async () => {
    for (const curatedTopic of exploreTopics) {
      const graph = await loadExploreGraph(curatedTopic);
      expect(graph, curatedTopic.slug).not.toBeNull();
      expect(graph?.nodes.length, curatedTopic.slug).toBeGreaterThan(0);
    }
  });
});
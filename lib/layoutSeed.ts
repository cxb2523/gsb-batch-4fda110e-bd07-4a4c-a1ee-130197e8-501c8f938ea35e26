import type { CrawlResult, WikiNode } from '@/types/graph';

export interface LayoutPosition {
  x: number;
  y: number;
}

export function seedInitialPositions(
  nodes: WikiNode[],
  seedId: string,
): Map<string, LayoutPosition> {
  const positions = new Map<string, LayoutPosition>();
  const random = mulberry32(hashString(seedId));
  const groups = new Map<number, WikiNode[]>();

  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    const group = groups.get(node.communityId) ?? [];
    group.push(node);
    groups.set(node.communityId, group);
  }

  const communities = [...groups.entries()].sort(([left], [right]) => left - right);
  communities.forEach(([, communityNodes], communityIndex) => {
    const angle = communityIndex * Math.PI * (3 - Math.sqrt(5));
    const radius = 30 * Math.sqrt(communityIndex + 1);
    const center = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };

    communityNodes.forEach((node, nodeIndex) => {
      const jitterRadius = 16 * Math.sqrt(random());
      const jitterAngle = random() * Math.PI * 2 + nodeIndex * 0.37;
      positions.set(node.id, {
        x: center.x + Math.cos(jitterAngle) * jitterRadius,
        y: center.y + Math.sin(jitterAngle) * jitterRadius,
      });
    });
  });

  const seedPosition = positions.get(seedId);
  if (seedPosition) {
    positions.set(seedId, { x: 0, y: 0 });
  }

  return positions;
}

export function positionNearNeighbors(
  nodeId: string,
  edges: CrawlResult['edges'],
  positions: Map<string, LayoutPosition>,
  seedId: string,
  neighborsByNode?: Map<string, Set<string>>,
): LayoutPosition {
  let neighborIds = neighborsByNode?.get(nodeId);
  if (!neighborIds) {
    neighborIds = new Set<string>();
    for (const edge of edges) {
      if (edge.source === nodeId) neighborIds.add(edge.target);
      if (edge.target === nodeId) neighborIds.add(edge.source);
    }
  }

  const neighbors = [...neighborIds]
    .map((neighborId) => positions.get(neighborId))
    .filter((position): position is LayoutPosition => Boolean(position));
  const anchor = neighbors.length > 0
    ? neighbors.reduce((sum, position) => ({ x: sum.x + position.x, y: sum.y + position.y }), { x: 0, y: 0 })
    : positions.get(seedId) ?? { x: 0, y: 0 };
  const divisor = neighbors.length || 1;
  const random = mulberry32(hashString(`${seedId}:${nodeId}`));
  const radius = 18 * Math.sqrt(random());
  const angle = random() * Math.PI * 2;

  return {
    x: anchor.x / divisor + Math.cos(angle) * radius,
    y: anchor.y / divisor + Math.sin(angle) * radius,
  };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

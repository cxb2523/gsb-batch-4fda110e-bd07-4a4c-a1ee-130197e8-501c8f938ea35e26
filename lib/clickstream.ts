import type { WikiEdge, WikiNode } from '@/types/graph';

export type ClickstreamCounts = Record<string, number>;

export function clickstreamEdgeKey(source: string, target: string): string {
  return JSON.stringify([source, target]);
}

function normalizeTitle(title: string): string {
  return title.replace(/_/g, ' ').trim().normalize('NFC');
}

export async function readClickstream(
  stream: ReadableStream<Uint8Array>,
  nodes: WikiNode[],
  edges: WikiEdge[],
): Promise<ClickstreamCounts> {
  const titles = new Map(nodes.map((node) => [node.id, normalizeTitle(node.title)]));
  const graphEdges = new Map<string, string>();
  for (const edge of edges) {
    const source = titles.get(edge.source);
    const target = titles.get(edge.target);
    if (source && target) graphEdges.set(clickstreamEdgeKey(source, target), clickstreamEdgeKey(edge.source, edge.target));
  }

  const counts: ClickstreamCounts = {};
  let validRows = 0;
  let pending = '';
  const decoder = new TextDecoder();
  const reader = stream.getReader();

  const processLine = (line: string) => {
    const fields = line.replace(/\r$/, '').split('\t');
    if (fields.length !== 4 || !/^\d+$/.test(fields[3])) return;
    const count = Number(fields[3]);
    if (!Number.isSafeInteger(count) || count < 0 || !fields[0] || !fields[1] || !fields[2]) return;
    validRows += 1;
    if (fields[2] !== 'link') return;
    const key = graphEdges.get(clickstreamEdgeKey(normalizeTitle(fields[0]), normalizeTitle(fields[1])));
    if (key) counts[key] = (counts[key] ?? 0) + count;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) processLine(line);
      if (pending.length > 65536) throw new Error('Invalid clickstream file: a row is too long.');
      if (done) break;
    }
    if (pending) processLine(pending);
  } finally {
    reader.releaseLock();
  }

  if (validRows === 0) throw new Error('No clickstream records found. Select a Wikimedia clickstream TSV file.');
  return counts;
}
import { describe, expect, it } from 'vitest';
import { clickstreamEdgeKey, readClickstream } from './clickstream';
import type { WikiNode } from '@/types/graph';

const nodes = [
  { id: 'one', title: 'Albert Einstein' },
  { id: 'two', title: 'Theory of relativity' },
] as WikiNode[];
const edges = [{ source: 'one', target: 'two' }, { source: 'two', target: 'one' }];

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('readClickstream', () => {
  it('matches directed article links across chunk boundaries and ignores other traffic', async () => {
    const counts = await readClickstream(stream(
      'Albert_Einstein\tTheory_of_',
      'relativity\tlink\t1234\r\nTheory_of_relativity\tAlbert_Einstein\tlink\t42\n',
      'other-search\tAlbert_Einstein\texternal\t900\nAlbert_Einstein\tOther\tlink\t99',
    ), nodes, edges);

    expect(counts).toEqual({
      [clickstreamEdgeKey('one', 'two')]: 1234,
      [clickstreamEdgeKey('two', 'one')]: 42,
    });
  });

  it('leaves absent links unavailable and rejects invalid files', async () => {
    expect(await readClickstream(stream('other-search\tAlbert_Einstein\texternal\t10\n'), nodes, edges)).toEqual({});
    await expect(readClickstream(stream('not a clickstream file'), nodes, edges)).rejects.toThrow('No clickstream records');
  });
});
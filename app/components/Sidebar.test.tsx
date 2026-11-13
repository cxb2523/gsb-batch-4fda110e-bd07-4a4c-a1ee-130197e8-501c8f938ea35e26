// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CrawlResult, WikiNode } from '@/types/graph';
import { MemoizedSidebar } from './Sidebar';

function makeNode(id: string, pagerank: number, betweenness: number, communityId = 0): WikiNode {
  return { id, title: id, url: '', depth: 0, inDegree: 0, outDegree: 0, pagerank, betweenness, communityId };
}

function makeData(nodes: WikiNode[], communities: CrawlResult['communities'] = []): CrawlResult {
  return { id: 'test', seedId: nodes[0].id, nodes, edges: [], communities, crawledAt: '', positions: {} };
}

describe('Sidebar rankings and filters', () => {
  afterEach(() => cleanup());
  it('orders Bridges by betweenness and excludes the seed', () => {
    const data = makeData([
      makeNode('Seed', 1, 100),
      makeNode('Bridge low', 0.5, 2),
      makeNode('Bridge high', 0.4, 9),
    ]);
    render(<MemoizedSidebar data={data} onNodeSelect={vi.fn()} onCommunitySelect={vi.fn()} focusedNode={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show bridges' }));

    expect(screen.getByText('Bridge high')).toBeInTheDocument();
    expect(screen.getByText('Bridge low')).toBeInTheDocument();
    expect(screen.queryByText('Seed')).not.toBeInTheDocument();
    expect(screen.getByText('Bridge high').compareDocumentPosition(screen.getByText('Bridge low')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('scales PageRank bars relative to the graph maximum', () => {
    const data = makeData([makeNode('Seed', 0.2, 0), makeNode('Half', 0.1, 0)]);
    const { container } = render(<MemoizedSidebar data={data} onNodeSelect={vi.fn()} onCommunitySelect={vi.fn()} focusedNode={null} />);
    const bars = [...container.querySelectorAll('button > div > div > div')];
    expect(bars.map((bar) => bar.getAttribute('style'))).toEqual(['width: 100%;', 'width: 50%;']);
  });

  it('filters beyond the top ten and selects the first match on Enter', () => {
    const select = vi.fn();
    const data = makeData([
      makeNode('Seed', 1, 0),
      ...Array.from({ length: 11 }, (_, index) => makeNode(`Page ${index}`, 0.9 - index / 100, 0)),
      makeNode('Hidden match', 0.01, 0),
    ]);
    render(<MemoizedSidebar data={data} onNodeSelect={select} onCommunitySelect={vi.fn()} focusedNode={null} />);
    const filter = screen.getByLabelText('Filter pages');
    fireEvent.change(filter, { target: { value: 'Hidden match' } });
    expect(screen.getByText('Hidden match')).toBeInTheDocument();
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(select).toHaveBeenCalledWith('Hidden match');
  });

  it('marks the selected community tab and community row', () => {
    const selectCommunity = vi.fn();
    const data = makeData(
      [makeNode('Seed', 1, 0, 0), makeNode('Community page', 0.5, 0, 1)],
      [{ id: 1, label: 'Community page', size: 2, topPages: ['Community page'] }],
    );
    render(<MemoizedSidebar data={data} onNodeSelect={vi.fn()} onCommunitySelect={selectCommunity} focusedNode={null} focusedCommunityId={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show clusters' }));
    const row = screen.getByRole('button', { name: /Community page/ });
    expect(screen.getByRole('button', { name: 'Show clusters' })).toHaveAttribute('aria-pressed', 'true');
    expect(row).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(row);
    expect(selectCommunity).toHaveBeenCalledWith(1);
  });

  it('closes the desktop Atlas panel through its accessible close control', () => {
    const close = vi.fn();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 701px)' }));
    const data = makeData([makeNode('Seed', 1, 0)]);
    render(<MemoizedSidebar data={data} onNodeSelect={vi.fn()} onCommunitySelect={vi.fn()} focusedNode={null} onDesktopClose={close} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close atlas sidebar' }));
    expect(close).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
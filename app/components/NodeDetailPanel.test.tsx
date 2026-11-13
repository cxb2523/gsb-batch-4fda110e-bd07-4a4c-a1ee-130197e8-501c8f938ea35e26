// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import type { CrawlResult, WikiNode } from '@/types/graph';
import { MemoizedNodeDetailPanel } from './NodeDetailPanel';
import * as summaryModule from '@/lib/summary';
import * as relationshipModule from '@/lib/relationshipClient';

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function makeNode(overrides: Partial<WikiNode> = {}): WikiNode {
  return {
    id: 'Quantum mechanics',
    title: 'Quantum mechanics',
    url: 'https://en.wikipedia.org/wiki/Quantum_mechanics',
    depth: 0,
    inDegree: 0,
    outDegree: 0,
    pagerank: 0.1,
    betweenness: 0,
    communityId: 0,
    ...overrides,
  };
}

function makeData(node: WikiNode): CrawlResult {
  return {
    id: 'test',
    seedId: node.id,
    nodes: [node],
    edges: [],
    communities: [],
    crawledAt: '',
    positions: {},
  };
}

describe('NodeDetailPanel summary', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a skeleton while the summary is loading', async () => {
    vi.spyOn(summaryModule, 'fetchSummary').mockReturnValue(new Promise(() => {}));
    const node = makeNode();

    render(
      <MemoizedNodeDetailPanel node={node} data={makeData(node)} onClose={vi.fn()} onExpand={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByTestId('node-summary-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('node-summary-error')).not.toBeInTheDocument();
  });

  it('renders the thumbnail, description and extract once loaded', async () => {
    vi.spyOn(summaryModule, 'fetchSummary').mockResolvedValue({
      extract: 'Quantum mechanics is a fundamental theory in physics.',
      description: 'Theory of matter and energy',
      thumbnail: { source: 'https://example.test/thumb.jpg', width: 200, height: 100 },
    });
    const node = makeNode();

    render(
      <MemoizedNodeDetailPanel node={node} data={makeData(node)} onClose={vi.fn()} onExpand={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(screen.getByTestId('node-summary-extract'))
      .toHaveTextContent('Quantum mechanics is a fundamental theory in physics.'));
    expect(screen.getByText('Theory of matter and energy')).toBeInTheDocument();
    const thumbnail = screen.getByTestId('node-summary-thumbnail');
    const img = thumbnail.querySelector('img');
    expect(img).toHaveAttribute('src', 'https://example.test/thumb.jpg');
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('shows an error state when the summary fails to load', async () => {
    vi.spyOn(summaryModule, 'fetchSummary').mockRejectedValue(new Error('boom'));
    const node = makeNode();

    render(
      <MemoizedNodeDetailPanel node={node} data={makeData(node)} onClose={vi.fn()} onExpand={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(screen.getByTestId('node-summary-error')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByTestId('node-summary-skeleton')).not.toBeInTheDocument();
  });

  it('makes Explore deeper the primary node action', () => {
    const node = makeNode();
    const onExpand = vi.fn();

    render(
      <MemoizedNodeDetailPanel node={node} data={makeData(node)} onClose={vi.fn()} onExpand={onExpand} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByRole('button', { name: /Explore deeper/ }));
    expect(onExpand).toHaveBeenCalledWith(node.id);
  });

  it('shows the exploration toolbelt above the summary and scrolls to connections', () => {
    vi.spyOn(summaryModule, 'fetchSummary').mockReturnValue(new Promise(() => {}));
    const node = makeNode();
    const connectedNode = makeNode({ id: 'Quantum field theory', title: 'Quantum field theory' });
    const data: CrawlResult = {
      ...makeData(node),
      nodes: [node, connectedNode],
      edges: [{ source: node.id, target: connectedNode.id }],
    };
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

    try {
      render(
        <MemoizedNodeDetailPanel node={node} data={data} onClose={vi.fn()} onExpand={vi.fn()} />,
        { wrapper: createWrapper() },
      );

      const explore = screen.getByRole('region', { name: 'Explore this page' });
      const summary = screen.getByTestId('node-summary-skeleton');
      expect(explore.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByRole('button', { name: /Connections/ })).toBeInTheDocument();
      expect(screen.getByText('Select a connection to see how the topics are related.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Find a path' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Explore deeper/ })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Connections/ }));
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' });
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
  });

  it('opens the path picker from the exploration toolbelt', () => {
    vi.spyOn(summaryModule, 'fetchSummary').mockReturnValue(new Promise(() => {}));
    const node = makeNode();
    const target = makeNode({ id: 'Quantum field theory', title: 'Quantum field theory' });
    const data: CrawlResult = {
      ...makeData(node),
      nodes: [node, target],
      edges: [{ source: node.id, target: target.id }],
    };
    const onFindPath = vi.fn();

    render(
      <MemoizedNodeDetailPanel
        node={node}
        data={data}
        onClose={vi.fn()}
        onExpand={vi.fn()}
        onFindPath={onFindPath}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Find a path' }));
    fireEvent.click(screen.getByRole('option', { name: 'Quantum field theory' }));

    expect(onFindPath).toHaveBeenCalledWith(node.id, target.id);
    expect(screen.queryByRole('combobox', { name: 'Find path to a node' })).not.toBeInTheDocument();
  });

  it('loads a relationship on demand and progressively reveals its source passage', async () => {
    vi.spyOn(summaryModule, 'fetchSummary').mockResolvedValue({
      extract: 'A physicist.',
      description: null,
    });
    vi.spyOn(relationshipModule, 'fetchRelationship').mockResolvedValue({
      source: 'Albert Einstein',
      target: 'Theory of relativity',
      relation: 'developed',
      context: 'lead',
      explanation: 'WikiCrawl interprets this passage as: Albert Einstein developed Theory of relativity.',
      evidence: 'Albert Einstein developed the theory of relativity.',
      section: 'Lead',
      sourceUrl: 'https://en.wikipedia.org/wiki/Albert_Einstein',
      sourceContextFound: true,
    });
    const source = makeNode({ id: 'Albert Einstein', title: 'Albert Einstein' });
    const target = makeNode({ id: 'Theory of relativity', title: 'Theory of relativity' });
    const data: CrawlResult = {
      ...makeData(source),
      nodes: [source, target],
      edges: [{ source: source.id, target: target.id }],
    };

    render(
      <MemoizedNodeDetailPanel node={source} data={data} onClose={vi.fn()} onExpand={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Explain connection: Albert Einstein to Theory of relativity' }));
    expect(await screen.findByText('developed')).toBeInTheDocument();
    expect(screen.getByTestId('relationship-context')).toHaveTextContent('Lead');
    expect(screen.getByText('Why')).toBeInTheDocument();
    const sourcePassage = screen.getByText('Source evidence · Lead').closest('details');
    expect(sourcePassage).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Source evidence · Lead'));
    expect(await screen.findByText('Albert Einstein developed the theory of relativity.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open source article on Wikipedia' })).toHaveAttribute(
      'href',
      'https://en.wikipedia.org/wiki/Albert_Einstein',
    );
  });

  it('imports clickstream counts and distinguishes missing directed links', async () => {
    vi.spyOn(summaryModule, 'fetchSummary').mockReturnValue(new Promise(() => {}));
    vi.spyOn(relationshipModule, 'fetchRelationship').mockReturnValue(new Promise(() => {}));
    const source = makeNode({ id: 'Albert Einstein', title: 'Albert Einstein' });
    const target = makeNode({ id: 'Theory of relativity', title: 'Theory of relativity' });
    const data: CrawlResult = {
      ...makeData(source),
      nodes: [source, target],
      edges: [{ source: source.id, target: target.id }, { source: target.id, target: source.id }],
    };
    const file = new File([], 'clickstream-enwiki-2026-01.tsv');
    Object.defineProperty(file, 'stream', { value: () => new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('Albert_Einstein\tTheory_of_relativity\tlink\t1234\n'));
        controller.close();
      },
    }) });

    const { rerender } = render(
      <MemoizedNodeDetailPanel node={source} data={data} onClose={vi.fn()} onExpand={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Clickstream data'));
    fireEvent.change(screen.getByLabelText('Choose file'), { target: { files: [file] } });
    expect(await screen.findByText(/1 matching directed links/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Explain connection: Albert Einstein to Theory of relativity, 1,234 visits' }));
    expect(screen.getAllByText('1,234')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Explain connection: Theory of relativity to Albert Einstein' }));
    expect(screen.getByText('Not reported in this file')).toBeInTheDocument();
    const added = makeNode({ id: 'Physics', title: 'Physics' });
    const expandedData = { ...data, nodes: [...data.nodes, added], edges: [...data.edges, { source: source.id, target: added.id }] };
    rerender(<MemoizedNodeDetailPanel node={source} data={expandedData} onClose={vi.fn()} onExpand={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Explain connection: Albert Einstein to Physics' }));
    expect(screen.getByText('Not included in this import; reimport to check')).toBeInTheDocument();
  });

  it('reveals connections beyond the initial six', () => {
    vi.spyOn(summaryModule, 'fetchSummary').mockReturnValue(new Promise(() => {}));
    const node = makeNode();
    const targets = Array.from({ length: 7 }, (_, index) => makeNode({ id: `Page ${index}`, title: `Page ${index}` }));
    const data: CrawlResult = { ...makeData(node), nodes: [node, ...targets], edges: targets.map((target) => ({ source: node.id, target: target.id })) };

    render(<MemoizedNodeDetailPanel node={node} data={data} onClose={vi.fn()} onExpand={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.queryByRole('button', { name: 'Explain connection: Quantum mechanics to Page 6' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7 connections' }));
    expect(screen.getByRole('button', { name: 'Explain connection: Quantum mechanics to Page 6' })).toBeInTheDocument();
  });

  it('shows See also as context without claiming a specific relationship', async () => {
    vi.spyOn(summaryModule, 'fetchSummary').mockResolvedValue({
      extract: 'An example article.',
      description: null,
    });
    vi.spyOn(relationshipModule, 'fetchRelationship').mockResolvedValue({
      source: 'Example',
      target: 'Related topic',
      relation: 'Related to',
      context: 'see_also',
      explanation: 'Wikipedia lists this topic as a related topic.',
      evidence: null,
      section: 'See also',
      sourceUrl: 'https://en.wikipedia.org/wiki/Example',
      sourceContextFound: true,
    });
    const source = makeNode({ id: 'Example', title: 'Example' });
    const target = makeNode({ id: 'Related topic', title: 'Related topic' });
    const data: CrawlResult = {
      ...makeData(source),
      nodes: [source, target],
      edges: [{ source: source.id, target: target.id }],
    };

    render(
      <MemoizedNodeDetailPanel node={source} data={data} onClose={vi.fn()} onExpand={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Explain connection: Example to Related topic' }));
    expect(await screen.findByTestId('relationship-context')).toHaveTextContent('See also');
    expect(screen.getByText('Related to')).toBeInTheDocument();
    expect(screen.getByText('Wikipedia lists this topic as a related topic.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open See also section on Wikipedia' })).toHaveAttribute(
      'href',
      'https://en.wikipedia.org/wiki/Example#See_also',
    );
  });
});

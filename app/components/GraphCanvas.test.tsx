// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CrawlResult } from '@/types/graph';
import { GraphCanvas } from './GraphCanvas';
import * as shareGraph from '@/lib/shareGraph';

const cameraReset = vi.hoisted(() => vi.fn());
const sigmaHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());
const forceLayoutCalls = vi.hoisted(() => [] as Array<{ changeKey: string; newNodeIds: string[] }>);

vi.mock('sigma', () => ({
  Sigma: class MockSigma {
    constructor() {}
    on(event: string, handler: (...args: unknown[]) => void) { sigmaHandlers.set(event, handler); }
    getCamera() {
      return {
        on() {},
        removeListener() {},
        getState: () => ({ ratio: 1 }),
        animate: vi.fn(),
        animatedReset: cameraReset,
      };
    }
    getNodeDisplayData() { return undefined; }
    getDimensions() { return { width: 800, height: 600 }; }
    setCustomBBox() {}
    refresh() {}
    getContainer() { return document.createElement('div'); }
    setSetting() {}
    kill() {}
    graphToViewport(position: { x: number; y: number }) { return position; }
  },
}));

vi.mock('sigma/rendering', () => ({
  EdgeArrowProgram: class MockEdgeArrowProgram {},
  EdgeLineProgram: class MockEdgeLineProgram {},
}));

vi.mock('./useForceLayout', () => ({
  getRememberedPositions: () => undefined,
  seedInitialPositions: () => new Map(),
  useForceLayout: (_graph: unknown, options: { changeKey: string; newNodeIds: string[] }) => {
    forceLayoutCalls.push({ changeKey: options.changeKey, newNodeIds: [...options.newNodeIds] });
    return { arranging: false, paused: false, ready: true, togglePause: vi.fn() };
  },
}));

vi.mock('./useNodeSummary', () => ({
  useNodeSummary: () => ({ data: null }),
  usePrefetchNodeSummary: () => vi.fn(),
}));

function makeData(): CrawlResult {
  return {
    id: 'test',
    seedId: 'A',
    nodes: [
      { id: 'A', title: 'A', url: '', depth: 0, inDegree: 1, outDegree: 1, pagerank: 0.5, betweenness: 0, communityId: 0 },
      { id: 'B', title: 'B', url: '', depth: 1, inDegree: 1, outDegree: 0, pagerank: 0.2, betweenness: 0, communityId: 0 },
    ],
    edges: [{ source: 'A', target: 'B' }],
    communities: [],
    crawledAt: '',
    positions: {},
  };
}

describe('GraphCanvas DOM ownership', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    sigmaHandlers.clear();
    forceLayoutCalls.length = 0;
  });

  it('keeps React overlays outside the Sigma container', () => {
    const { container } = render(
      <StrictMode>
        <GraphCanvas data={makeData()} colorMode="community" onNodeClick={vi.fn()} focusedNode={null} path={null} />
      </StrictMode>,
    );

    const sigmaContainer = container.querySelector('.graph-surface');
    expect(sigmaContainer).toBeInTheDocument();
    expect(sigmaContainer).toBeEmptyDOMElement();
    expect(sigmaContainer).not.toContainElement(screen.getByRole('button', { name: 'Zoom in' }));
    expect(sigmaContainer).not.toContainElement(screen.getByText('Exploration map'));
  });

  it('clears the current selection when the graph background is clicked', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    const onStageClick = vi.fn();
    render(
      <GraphCanvas
        data={makeData()}
        colorMode="community"
        onNodeClick={vi.fn()}
        onStageClick={onStageClick}
        focusedNode={null}
        path={null}
      />,
    );

    await waitFor(() => expect(sigmaHandlers.has('clickStage')).toBe(true));
    sigmaHandlers.get('clickStage')?.();

    expect(onStageClick).toHaveBeenCalledOnce();
  });

  it('defers the initial camera fit until real nodes arrive after the seed preview', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    cameraReset.mockClear();
    const completeData = makeData();
    const previewData = {
      ...completeData,
      id: 'streaming',
      nodes: [completeData.nodes[0]],
      edges: [],
    };
    const props = {
      colorMode: 'community' as const,
      onNodeClick: vi.fn(),
      focusedNode: null,
      path: null,
    };
    const { rerender } = render(
      <GraphCanvas {...props} data={previewData} isStreaming />,
    );

    expect(cameraReset).not.toHaveBeenCalled();
    rerender(<GraphCanvas {...props} data={completeData} isStreaming />);

    await waitFor(() => expect(cameraReset).toHaveBeenCalledTimes(1));
  });

  it('restarts layout for expanded nodes while keeping existing nodes fixed', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    const initialData = makeData();
    const props = {
      colorMode: 'community' as const,
      onNodeClick: vi.fn(),
      focusedNode: null,
      path: null,
    };
    const { rerender } = render(<GraphCanvas {...props} data={initialData} />);

    await waitFor(() => expect(forceLayoutCalls.at(-1)?.changeKey).toBe('A:1'));
    forceLayoutCalls.length = 0;
    rerender(
      <GraphCanvas
        {...props}
        data={{
          ...initialData,
          nodes: [
            ...initialData.nodes,
            { id: 'C', title: 'C', url: '', depth: 2, inDegree: 0, outDegree: 1, pagerank: 0.1, betweenness: 0, communityId: 0 },
          ],
          edges: [...initialData.edges, { source: 'B', target: 'C' }],
        }}
      />,
    );

    await waitFor(() => expect(forceLayoutCalls.at(-1)?.changeKey).toBe('A:2'));
    expect(forceLayoutCalls.at(-1)?.newNodeIds).toEqual(['C']);
  });

  it('only enables sharing for a completed graph and copies a snapshot link', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    const encode = vi.spyOn(shareGraph, 'encodeSharedGraph').mockResolvedValue('snapshot');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const props = { data: makeData(), colorMode: 'depth' as const, onNodeClick: vi.fn(), focusedNode: null, path: null, reduceEffects: true, shareSettings: { depth: 2, maxNodes: 150 } };
    const { rerender } = render(<GraphCanvas {...props} isStreaming />);

    expect(screen.getByRole('button', { name: 'Copy graph link' })).toBeDisabled();
    rerender(<GraphCanvas {...props} isExpanding />);
    expect(screen.getByRole('button', { name: 'Download graph screenshot' })).toBeDisabled();
    rerender(<GraphCanvas {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy graph link' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/#graph=snapshot')));
    expect(encode).toHaveBeenCalledWith(expect.objectContaining({ depth: 2, maxNodes: 150, colorMode: 'depth' }));
    expect(screen.getByRole('status')).toHaveTextContent('Graph link copied.');
    Reflect.deleteProperty(navigator, 'clipboard');
  });
});
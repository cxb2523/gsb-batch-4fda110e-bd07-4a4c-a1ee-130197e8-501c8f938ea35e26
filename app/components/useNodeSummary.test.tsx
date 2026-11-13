// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen, waitFor, cleanup } from '@testing-library/react';
import { useNodeSummary } from './useNodeSummary';
import * as summaryModule from '@/lib/summary';

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useNodeSummary', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('dedupes concurrent requests for the same title', async () => {
    const fetchSummarySpy = vi.spyOn(summaryModule, 'fetchSummary').mockResolvedValue({
      extract: 'A test extract.',
      description: 'A test description',
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function TwoConsumers() {
      const first = useNodeSummary('Quantum mechanics');
      const second = useNodeSummary('Quantum mechanics');
      return (
        <div>
          <span data-testid="first">{first.data?.extract ?? 'loading'}</span>
          <span data-testid="second">{second.data?.extract ?? 'loading'}</span>
        </div>
      );
    }

    render(<TwoConsumers />, { wrapper: createWrapper(client) });

    await waitFor(() => expect(screen.getByTestId('first')).toHaveTextContent('A test extract.'));
    expect(screen.getByTestId('second')).toHaveTextContent('A test extract.');
    expect(fetchSummarySpy).toHaveBeenCalledTimes(1);
  });

  it('does not fetch when disabled, but reflects data already in the cache', async () => {
    const fetchSummarySpy = vi.spyOn(summaryModule, 'fetchSummary').mockResolvedValue({
      extract: 'Cached extract.',
      description: null,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = createWrapper(client);

    const { result: fetcher } = renderHook(() => useNodeSummary('Cached page'), { wrapper });
    await waitFor(() => expect(fetcher.current.data?.extract).toBe('Cached extract.'));

    fetchSummarySpy.mockClear();
    const { result: readOnly } = renderHook(
      () => useNodeSummary('Cached page', { enabled: false }),
      { wrapper },
    );

    expect(readOnly.current.data?.extract).toBe('Cached extract.');
    expect(fetchSummarySpy).not.toHaveBeenCalled();
  });
});

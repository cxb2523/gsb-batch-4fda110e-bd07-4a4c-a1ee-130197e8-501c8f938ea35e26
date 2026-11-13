import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSummary } from './summary';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchSummary', () => {
  it('aborts a summary request after eight seconds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const request = fetchSummary('Slow page');
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });

    await vi.advanceTimersByTimeAsync(8000);
    await rejection;

    expect(fetchMock).toHaveBeenCalledWith(
      'https://en.wikipedia.org/api/rest_v1/page/summary/Slow%20page?redirect=true',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

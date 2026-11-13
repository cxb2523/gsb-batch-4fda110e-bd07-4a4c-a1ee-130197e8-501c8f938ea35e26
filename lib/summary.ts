const SUMMARY_BASE_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const SUMMARY_TIMEOUT_MS = 8000;

export interface PageSummary {
  extract: string;
  description: string | null;
  thumbnail?: { source: string; width: number; height: number };
}

interface RawSummaryResponse {
  extract?: string;
  description?: string;
  thumbnail?: { source?: string; width?: number; height?: number };
}

// Wikimedia's REST API allows CORS and is served from its own CDN, so fetching
// straight from the browser skips an extra hop (and cache layer) through our server.
export async function fetchSummary(title: string): Promise<PageSummary> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

  try {
    const response = await fetch(`${SUMMARY_BASE_URL}/${encodeURIComponent(title)}?redirect=true`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to load summary for "${title}" (${response.status})`);
    }

    const data = (await response.json()) as RawSummaryResponse;
    const thumbnail = data.thumbnail?.source && data.thumbnail.width && data.thumbnail.height
      ? { source: data.thumbnail.source, width: data.thumbnail.width, height: data.thumbnail.height }
      : undefined;

    return {
      extract: data.extract ?? '',
      description: data.description ?? null,
      thumbnail,
    };
  } finally {
    clearTimeout(timeout);
  }
}

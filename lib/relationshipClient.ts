import type { WikiRelationship } from '@/types/graph';

export async function fetchRelationship(
  source: string,
  target: string,
  signal?: AbortSignal,
): Promise<WikiRelationship> {
  const params = new URLSearchParams({ source, target });
  const response = await fetch(`/api/relationship?${params.toString()}`, { signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `Could not load connection details (${response.status})`);
  }
  return response.json() as Promise<WikiRelationship>;
}

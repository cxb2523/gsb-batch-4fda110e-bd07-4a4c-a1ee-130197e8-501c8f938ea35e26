/**
 * The checkable collection line for the target catalog. Infinite scroll
 * alone can't say whether a missing row means "no more" or "a page broke",
 * so this panel states exactly what the current collection holds:
 *
 *   - how many rows have loaded (and the de-duplicated figure),
 *   - whether another page exists, the collection is whole, or a page
 *     failure interrupted it (and at which page),
 *   - the effective value of every server-side filter, so an admin can
 *     confirm a filter actually applied instead of guessing from the rows.
 */

import type { CatalogFilter } from '../../api/gateways';
import type { CatalogCollectionSummary } from '../../lib/catalogCollection';
import { Banner } from '../../ui/Banner';
import { Button } from '../../ui/Button';

const FILTER_LABELS: Record<keyof CatalogFilter, string> = {
  gateway_id: 'Gateway id',
  connector_uuid: 'Connector',
  project_id: 'Project',
  app_project: 'AppProject',
  namespace: 'Namespace',
  q: 'Name contains',
  status: 'State',
};

/** Human-readable text for each filter's current effective value. */
function activeFilters(
  filter: CatalogFilter,
  projectName: (id: string) => string,
): Array<{ key: keyof CatalogFilter; label: string; value: string }> {
  const out: Array<{ key: keyof CatalogFilter; label: string; value: string }> =
    [];
  (Object.keys(FILTER_LABELS) as Array<keyof CatalogFilter>).forEach((key) => {
    const raw = filter[key];
    if (!raw) return;
    const value = key === 'project_id' ? projectName(raw) || raw : raw;
    out.push({ key, label: FILTER_LABELS[key], value });
  });
  return out;
}

function StateLine({ summary }: { summary: CatalogCollectionSummary }) {
  if (summary.failure) {
    const noun = summary.uniqueCount === 1 ? 'target stays' : 'targets stay';
    return (
      <span className="text-bad">
        Interrupted at page {summary.failure.page} · {summary.failure.reason} ·{' '}
        {summary.uniqueCount} {noun} loaded
      </span>
    );
  }
  if (summary.complete) {
    return (
      <span className="text-muted">Collection complete · no more pages</span>
    );
  }
  return (
    <span className="text-muted">
      More pages may exist · next page not loaded yet
    </span>
  );
}

interface Props {
  filter: CatalogFilter;
  summary: CatalogCollectionSummary;
  /** True while the first page is still on the wire. */
  loadingFirstPage: boolean;
  projectName: (id: string) => string | undefined;
  onRetry: () => void;
  retrying: boolean;
}

export function CollectionPanel({
  filter,
  summary,
  loadingFirstPage,
  projectName,
  onRetry,
  retrying,
}: Props) {
  const filters = activeFilters(filter, (id) => projectName(id) ?? '');
  const loaded = `${summary.uniqueCount} ${summary.uniqueCount === 1 ? 'target' : 'targets'} loaded`;
  const rawNote =
    summary.duplicateCount > 0
      ? ` (${summary.totalCount} rows returned, ${summary.duplicateCount} duplicate${summary.duplicateCount === 1 ? '' : 's'} removed)`
      : '';

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-edge bg-surface px-3.5 py-3"
      aria-live="polite"
    >
      <p
        className="text-ui font-semibold text-ink"
        data-testid="collection-loaded"
      >
        {loadingFirstPage ? 'Loading the first page…' : loaded}
        {!loadingFirstPage && rawNote && (
          <span className="font-normal text-muted">{rawNote}</span>
        )}
      </p>
      {!loadingFirstPage && (
        <p className="text-ui" data-testid="collection-state">
          <StateLine summary={summary} />
        </p>
      )}
      {summary.failure && (
        <Banner
          tone="error"
          title={`Collection interrupted at page ${summary.failure.page}.`}
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={onRetry}
              disabled={retrying}
              aria-busy={retrying}
            >
              {retrying ? 'Retrying…' : 'Retry page'}
            </Button>
          }
        >
          {summary.failure.reason} The rows already loaded stay listed; the
          retry resumes from the same cursor and never repeats an entry.
        </Banner>
      )}
      <p className="text-caption text-muted" data-testid="collection-filters">
        {filters.length === 0 ? (
          'No filters · every target the server lets this caller see.'
        ) : (
          <>
            Filters applied on the server:{' '}
            {filters.map((f, i) => (
              <span key={f.key}>
                {i > 0 && ' · '}
                <span className="text-ink">
                  {f.label} <span className="font-mono">{f.value}</span>
                </span>
              </span>
            ))}
          </>
        )}
      </p>
    </div>
  );
}

'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { useQuery } from '@tanstack/react-query';
import type { WikiNode, CrawlResult, PathResult, WikiEdge } from '@/types/graph';
import { buildAdjacency } from '@/lib/adjacency';
import { clickstreamEdgeKey, readClickstream, type ClickstreamCounts } from '@/lib/clickstream';
import { fetchRelationship } from '@/lib/relationshipClient';
import { useNodeSummary } from './useNodeSummary';

interface NodeDetailPanelProps {
  node: WikiNode | null;
  data: CrawlResult | null;
  onClose: () => void;
  onExpand: (nodeId: string) => void;
  isExpanding?: boolean;
  isExpanded?: boolean;
  pathSelection?: { from: string; to: string; result: PathResult | null } | null;
  onFindPath?: (from: string, to: string) => void;
  onPathNodeClick?: (nodeId: string) => void;
  onClearPath?: () => void;
}

function NodeDetailPanel({
  node,
  data,
  onClose,
  onExpand,
  isExpanding = false,
  isExpanded = false,
  pathSelection = null,
  onFindPath = () => undefined,
  onPathNodeClick = () => undefined,
  onClearPath = () => undefined,
}: NodeDetailPanelProps) {
  const [pathPickerOpen, setPathPickerOpen] = useState(false);
  const [pathQuery, setPathQuery] = useState('');
  const [highlightedPathOption, setHighlightedPathOption] = useState(0);
  const [selectedConnection, setSelectedConnection] = useState<WikiEdge | null>(null);
  const [showAllConnections, setShowAllConnections] = useState(false);
  const [clickstream, setClickstream] = useState<{ seedId: string; name: string; counts: ClickstreamCounts; edgeKeys: Set<string> } | null>(null);
  const [clickstreamLoading, setClickstreamLoading] = useState(false);
  const [clickstreamError, setClickstreamError] = useState<string | null>(null);
  const clickstreamRequestRef = useRef(0);
  const connectionSectionRef = useRef<HTMLDivElement>(null);
  const connectedNodes = useMemo(() => {
    if (!node || !data) return [];
    const nodesById = new Map(data.nodes.map((candidate) => [candidate.id, candidate]));
    return (buildAdjacency(data.edges).get(node.id) ?? [])
      .map((connectedId) => nodesById.get(connectedId))
      .filter((connectedNode): connectedNode is WikiNode => Boolean(connectedNode));
  }, [data, node]);

  const connectionEdges = useMemo(() => {
    if (!node || !data) return [];
    return data.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  }, [data, node]);

  const { data: summary, isLoading: summaryLoading, isError: summaryError } = useNodeSummary(node?.id ?? null);
  const relationshipQuery = useQuery({
    queryKey: ['relationship', selectedConnection?.source, selectedConnection?.target],
    queryFn: ({ signal }) => fetchRelationship(selectedConnection!.source, selectedConnection!.target, signal),
    enabled: Boolean(selectedConnection),
    staleTime: 60 * 60 * 1000,
  });

  const pathOptions = useMemo(() => {
    if (!node || !data) return [];
    const query = pathQuery.trim().toLocaleLowerCase();
    return data.nodes
      .filter((candidate) => candidate.id !== node.id)
      .filter((candidate) => !query || candidate.title.toLocaleLowerCase().includes(query))
      .slice(0, 8);
  }, [data, node, pathQuery]);

  useEffect(() => {
    setPathPickerOpen(false);
    setPathQuery('');
    setHighlightedPathOption(0);
    setSelectedConnection(null);
    setShowAllConnections(false);
  }, [node?.id]);

  useEffect(() => {
    setHighlightedPathOption((current) => Math.min(current, Math.max(pathOptions.length - 1, 0)));
  }, [pathOptions.length]);

  useEffect(() => {
    clickstreamRequestRef.current += 1;
    setClickstream(null);
    setClickstreamLoading(false);
    setClickstreamError(null);
  }, [data?.seedId]);

  const importClickstream = async (file: File) => {
    if (!data) return;
    const request = ++clickstreamRequestRef.current;
    setClickstreamLoading(true);
    setClickstreamError(null);
    try {
      let stream = file.stream();
      if (file.name.toLowerCase().endsWith('.gz')) {
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open gzip files. Unzip the file and select the TSV instead.');
        stream = stream.pipeThrough(new DecompressionStream('gzip'));
      }
      const counts = await readClickstream(stream, data.nodes, data.edges);
      if (clickstreamRequestRef.current === request) {
        setClickstream({ seedId: data.seedId, name: file.name, counts, edgeKeys: new Set(data.edges.map((edge) => clickstreamEdgeKey(edge.source, edge.target))) });
      }
    } catch (error) {
      if (clickstreamRequestRef.current === request) {
        setClickstreamError(error instanceof Error ? error.message : 'Could not read the clickstream file.');
      }
    } finally {
      if (clickstreamRequestRef.current === request) setClickstreamLoading(false);
    }
  };

  const choosePathTarget = (target: WikiNode) => {
    if (!node) return;
    onFindPath(node.id, target.id);
    setPathPickerOpen(false);
    setPathQuery('');
  };

  if (!node || !data) return null;

  const activeClickstream = clickstream?.seedId === data.seedId ? clickstream : null;
  const selectedCount = selectedConnection && activeClickstream
    ? activeClickstream.counts[clickstreamEdgeKey(selectedConnection.source, selectedConnection.target)]
    : undefined;
  const community = data.communities.find(c => c.id === node.communityId);
  const contextLabel = relationshipQuery.data?.context === 'lead'
    ? 'Lead'
    : relationshipQuery.data?.context === 'article'
      ? 'Article body'
      : relationshipQuery.data?.context === 'see_also'
        ? 'See also'
        : 'Unavailable';
  const sourceSectionUrl = relationshipQuery.data
    ? relationshipQuery.data.context === 'see_also'
      ? `${relationshipQuery.data.sourceUrl}#See_also`
      : relationshipQuery.data.context === 'article' && relationshipQuery.data.section
        ? `${relationshipQuery.data.sourceUrl}#${encodeURIComponent(relationshipQuery.data.section.replace(/ /g, '_'))}`
        : relationshipQuery.data.sourceUrl
    : null;

  return (
  <>
    <button
      type="button"
      aria-label="Close node details"
      onClick={onClose}
      className="node-detail-backdrop"
    />

    <div
      className="node-detail mobile-sheet reduce-effects absolute right-4 top-4 z-50 w-80 glass-strong shadow-2xl overflow-hidden border border-cyan-500/20 animate-in slide-in-from-right"
      role="dialog"
      aria-modal="true"
      aria-label={`${node.title} page details`}
    >
    {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-white/10 bg-gradient-to-r from-cyan-500/10 to-purple-500/10">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="node-detail-mark flex-shrink-0">
            <div className="w-full h-full flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
          </div>
          <h3 className="text-lg font-bold text-white truncate">
            {node.title}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close node details"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-all hover:bg-white/10 hover:text-white"        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <section className="node-explore" aria-label="Explore this page">
        <div className="node-explore-heading">
          <h4>Explore</h4>
          <span>from this page</span>
        </div>
        <div className="node-explore-toolbelt">
          <button
            type="button"
            className="node-explore-action"
            aria-controls={connectedNodes.length > 0 ? 'node-connections' : undefined}
            onClick={() => connectionSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
            disabled={connectedNodes.length === 0}
          >
            <span>Connections</span>
            <span className="node-explore-count">{connectedNodes.length}</span>
          </button>
          <button
            type="button"
            aria-expanded={pathPickerOpen}
            aria-controls="node-path-picker"
            onClick={() => setPathPickerOpen((open) => !open)}
            className="node-explore-action"
          >
            Find a path
          </button>
          <button
            type="button"
            onClick={() => onExpand(node.id)}
            disabled={isExpanding || isExpanded}
            className="node-explore-action node-explore-action-primary"
          >
            {isExpanding ? (
              <><span className="node-action-spinner" aria-hidden="true" /> Exploring</>
            ) : isExpanded ? (
              <>Explored <span aria-hidden="true">✓</span></>
            ) : (
              <>Explore deeper <span aria-hidden="true">↗</span></>
            )}
          </button>
        </div>
        <p className="node-explore-hint">
          {connectedNodes.length > 0
            ? 'Select a connection to see how the topics are related.'
            : 'No connections yet. Explore deeper to grow this map.'}
        </p>
        {pathPickerOpen && (
          <div id="node-path-picker" className="node-path-picker">
            <input
              autoFocus
              role="combobox"
              aria-label="Find path to a node"
              aria-controls="path-target-list"
              aria-expanded="true"
              aria-activedescendant={pathOptions[highlightedPathOption] ? `path-target-${pathOptions[highlightedPathOption].id}` : undefined}
              value={pathQuery}
              onChange={(event) => {
                setPathQuery(event.target.value);
                setHighlightedPathOption(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setPathPickerOpen(false);
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setHighlightedPathOption((current) => Math.min(current + 1, pathOptions.length - 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setHighlightedPathOption((current) => Math.max(current - 1, 0));
                } else if (event.key === 'Enter' && pathOptions[highlightedPathOption]) {
                  event.preventDefault();
                  choosePathTarget(pathOptions[highlightedPathOption]);
                }
              }}
              placeholder="Search crawled nodes"
              className="w-full rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-sm text-white outline-none ring-cyan-400 placeholder:text-slate-500 focus:ring-2"
            />
            <div id="path-target-list" role="listbox" className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-white/10 bg-slate-950 shadow-xl">
              {pathOptions.length > 0 ? pathOptions.map((candidate, index) => (
                <button
                  key={candidate.id}
                  id={`path-target-${candidate.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === highlightedPathOption}
                  onMouseEnter={() => setHighlightedPathOption(index)}
                  onClick={() => choosePathTarget(candidate)}
                  className={`block w-full truncate px-3 py-2 text-left text-xs ${index === highlightedPathOption ? 'bg-cyan-400/15 text-cyan-100' : 'text-slate-300 hover:bg-white/5'}`}
                >
                  {candidate.title}
                </button>
              )) : (
                <p className="px-3 py-2 text-xs text-slate-500">No matching crawled nodes</p>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Content */}
      <div className="node-detail-content p-4 space-y-4 max-h-96 overflow-y-auto">
        {/* Summary: thumbnail, description, extract */}
        {(summaryLoading || summary?.thumbnail) && (
          <div data-testid="node-summary-thumbnail" className="relative w-full aspect-[16/9] overflow-hidden rounded-xl bg-slate-800/60">
            {summary?.thumbnail ? (
              <Image
                src={summary.thumbnail.source}
                alt=""
                width={summary.thumbnail.width}
                height={summary.thumbnail.height}
                unoptimized
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <div data-testid="node-summary-thumbnail-skeleton" className="h-full w-full animate-pulse bg-slate-700/40" />
            )}
          </div>
        )}

        {summaryLoading ? (
          <div data-testid="node-summary-skeleton" className="space-y-2">
            <div className="h-3 w-1/2 animate-pulse rounded bg-slate-700/40" />
            <div className="h-3 w-full animate-pulse rounded bg-slate-700/40" />
            <div className="h-3 w-full animate-pulse rounded bg-slate-700/40" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-slate-700/40" />
          </div>
        ) : summaryError ? (
          <p data-testid="node-summary-error" className="text-sm text-amber-400/90 italic">Couldn&apos;t load a preview for this page.</p>
        ) : (
          <>
            {summary?.description && (
              <p className="text-xs uppercase tracking-wide text-cyan-400/80">{summary.description}</p>
            )}
            <p data-testid="node-summary-extract" className="text-sm text-slate-300 leading-relaxed">
              {summary?.extract || 'No preview available for this page.'}
            </p>
          </>
        )}

        <div className="flex items-center gap-3 border-y border-white/10 py-3 text-xs text-slate-400">
          <span><strong className="text-white">{connectedNodes.length}</strong> connections</span>
          <span><strong className="text-white">{node.depth >= 0 ? node.depth : '?'}</strong> depth</span>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-2 gap-2">
          <MetricCard label="PageRank" value={node.pagerank.toFixed(4)} color="cyan" />
          <MetricCard label="Cluster" value={community?.label?.slice(0, 18) || 'Unclustered'} color="yellow" />
        </div>

        {pathSelection && (
          <div className="space-y-3 rounded-xl border border-cyan-400/25 bg-cyan-400/5 p-3" aria-live="polite">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-cyan-200">Shortest path</h4>
              <button type="button" onClick={onClearPath} className="text-xs text-slate-400 underline hover:text-white">Clear</button>
            </div>
            {pathSelection.result ? (
              <>
                <p className="text-xs text-slate-400">{pathSelection.result.length} {pathSelection.result.length === 1 ? 'hop' : 'hops'}</p>
                <ol className="space-y-1">
                  {pathSelection.result.path.map((nodeId, index) => {
                    const pathNode = data.nodes.find((candidate) => candidate.id === nodeId);
                    return (
                      <li key={nodeId} className="flex items-center gap-2 text-xs">
                        <span className="w-4 shrink-0 text-right text-slate-500">{index + 1}.</span>
                        <button type="button" onClick={() => onPathNodeClick(nodeId)} className="truncate text-left text-cyan-200 hover:text-white hover:underline">
                          {pathNode?.title ?? nodeId}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </>
            ) : (
              <p className="text-xs leading-relaxed text-amber-200">
                No path within the crawled graph. Try Expand on a node or increase depth.
              </p>
            )}
          </div>
        )}

        {connectedNodes.length > 0 && (
          <div id="node-connections" ref={connectionSectionRef}>
            <h4 className="text-xs font-semibold text-slate-400 uppercase mb-2 tracking-wide">Connections</h4>
            <div className="space-y-1">
              {(showAllConnections ? connectionEdges : connectionEdges.slice(0, 6)).map((edge) => {
                const source = data.nodes.find((candidate) => candidate.id === edge.source);
                const target = data.nodes.find((candidate) => candidate.id === edge.target);
                if (!source || !target) return null;
                const isSelected = selectedConnection?.source === edge.source && selectedConnection?.target === edge.target;
                const count = activeClickstream?.counts[clickstreamEdgeKey(edge.source, edge.target)];
                return (
                  <button
                    key={`${edge.source}|${edge.target}`}
                    type="button"
                    aria-label={`Explain connection: ${source.title} to ${target.title}${count === undefined ? '' : `, ${count.toLocaleString()} visits`}`}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedConnection(edge)}
                    className={`block min-h-11 w-full truncate rounded-lg px-2 py-2 text-left text-xs transition ${
                      isSelected ? 'bg-cyan-400/15 text-cyan-100' : 'text-slate-300 hover:bg-white/5 hover:text-white'
                    }`}
                  >
                    <span className="font-medium">{source.title}</span>
                    <span className="px-1.5 text-slate-500" aria-hidden="true">→</span>
                    <span className="font-medium">{target.title}</span>
                    {count !== undefined && <span className="ml-2 text-cyan-200">{count.toLocaleString()}</span>}
                  </button>
                );
              })}
            </div>
            {connectionEdges.length > 6 && (
              <button type="button" className="min-h-11 px-2 text-xs text-cyan-200 underline" onClick={() => setShowAllConnections((shown) => !shown)}>
                {showAllConnections ? 'Show fewer connections' : `Show all ${connectionEdges.length} connections`}
              </button>
            )}
          </div>
        )}

        <details className="clickstream-import">
          <summary>Clickstream data {activeClickstream ? <span>Loaded</span> : null}</summary>
          <p>Import an English Wikipedia monthly clickstream TSV or TSV.GZ. The file stays in your browser.</p>
          <a href="https://dumps.wikimedia.org/other/clickstream/" target="_blank" rel="noopener noreferrer">Wikimedia clickstream downloads</a>
          <label className="clickstream-file-label">
            {clickstreamLoading ? 'Reading file...' : activeClickstream ? 'Replace file' : 'Choose file'}
            <input
              type="file"
              accept=".tsv,.gz,.txt,text/tab-separated-values,application/gzip"
              disabled={clickstreamLoading}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) void importClickstream(file);
              }}
            />
          </label>
          <div aria-live="polite">
            {clickstreamError && <p className="clickstream-error">{clickstreamError}</p>}
            {activeClickstream && (
              <p>{activeClickstream.name}: {Object.keys(activeClickstream.counts).length.toLocaleString()} matching directed links.
                {data.edges.some((edge) => !activeClickstream.edgeKeys.has(clickstreamEdgeKey(edge.source, edge.target))) && ' Reimport to include newly added links.'}
              </p>
            )}
          </div>
          <p>Counts of 10 or fewer are omitted by Wikimedia; missing records are not zero.</p>
        </details>

        {selectedConnection && (
          <section
            className="space-y-3 rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-3"
            aria-label="Connection details"
            aria-live="polite"
          >
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-cyan-200">How they connect</h4>
              <button
                type="button"
                onClick={() => setSelectedConnection(null)}
                className="min-h-11 px-2 text-xs text-slate-400 underline hover:text-white"
              >
                Back to connections
              </button>
            </div>
            {activeClickstream && (
              <div className="clickstream-count">
                <h5>Monthly page-to-page visits</h5>
                <p>{selectedConnection && !activeClickstream.edgeKeys.has(clickstreamEdgeKey(selectedConnection.source, selectedConnection.target))
                  ? 'Not included in this import; reimport to check'
                  : selectedCount === undefined ? 'Not reported in this file' : selectedCount.toLocaleString()}</p>
                <span>{activeClickstream.name}</span>
              </div>
            )}
            {relationshipQuery.isLoading ? (
              <p className="text-xs text-slate-400">Checking the Wikipedia passage…</p>
            ) : relationshipQuery.isError ? (
              <div className="space-y-2">
                <p className="text-xs text-amber-200">Couldn&apos;t load the source context for this connection.</p>
                <button
                  type="button"
                  onClick={() => void relationshipQuery.refetch()}
                  className="min-h-11 text-xs text-cyan-200 underline hover:text-white"
                >
                  Try again
                </button>
              </div>
            ) : relationshipQuery.data ? (
              <>
                <div className="space-y-1 text-center text-xs">
                  <p className="font-medium text-white">{relationshipQuery.data.source}</p>
                  <p className="text-slate-500" aria-hidden="true">↓</p>
                  <p className="font-semibold text-cyan-100">{relationshipQuery.data.relation}</p>
                  <p className="text-slate-500" aria-hidden="true">↓</p>
                  <p className="font-medium text-white">{relationshipQuery.data.target}</p>
                </div>
                <div>
                  <h5 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Connection context</h5>
                  <p data-testid="relationship-context" className="text-xs text-slate-200">{contextLabel ?? 'Unavailable'}</p>
                </div>
                <div>
                  <h5 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Why</h5>
                  <p className="text-xs leading-relaxed text-slate-300">{relationshipQuery.data.explanation}</p>
                </div>
                {relationshipQuery.data.evidence ? (
                  <details className="text-xs">
                    <summary className="min-h-11 cursor-pointer py-3 font-semibold uppercase tracking-wide text-cyan-200 hover:text-white">
                      Source evidence{relationshipQuery.data.section ? ` · ${relationshipQuery.data.section}` : ''}
                    </summary>
                    <blockquote className="border-l-2 border-cyan-300/30 pl-3 leading-relaxed text-slate-300">
                      {relationshipQuery.data.evidence}
                    </blockquote>
                    <a
                      href={sourceSectionUrl ?? relationshipQuery.data.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex min-h-11 items-center text-cyan-200 underline hover:text-white"
                    >
                      Open source{relationshipQuery.data.context === 'article' ? ' section' : ' article'} on Wikipedia
                    </a>
                  </details>
                ) : relationshipQuery.data.context === 'see_also' ? (
                  <div className="space-y-1">
                    <h5 className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Source evidence</h5>
                    <p className="text-xs text-slate-300">Wikipedia lists this topic in the See also section.</p>
                    <a
                      href={sourceSectionUrl ?? relationshipQuery.data.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center text-cyan-200 underline hover:text-white"
                    >
                      Open See also section on Wikipedia
                    </a>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <h5 className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Source evidence</h5>
                    <p className="text-xs leading-relaxed text-slate-400">
                      No matching passage was found in the source article. WikiCrawl leaves this as “Related to”.
                    </p>
                    <a
                      href={sourceSectionUrl ?? relationshipQuery.data.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center text-cyan-200 underline hover:text-white"
                    >
                      Open source article on Wikipedia
                    </a>
                  </div>
                )}
              </>
            ) : null}
          </section>
        )}

        {/* Community Members */}
        {community && community.size > 1 && (
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase mb-2 tracking-wide">
              Cluster Members
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {community.topPages.map(title => (
                <span
                  key={title}
                  className={`text-xs px-2.5 py-1 rounded-lg font-medium ${
                    title === node.title
                      ? 'bg-gradient-to-r from-cyan-500 to-purple-500 text-white'
                      : 'bg-slate-800/80 text-slate-300 border border-white/5'
                  }`}
                >
                  {title}
                </span>
              ))}
              {community.size > 3 && (
                <span className="text-xs px-2.5 py-1 text-slate-500">
                  +{community.size - 3} more
                </span>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="node-detail-actions pt-2">
          <a
            href={node.url}
            target="_blank"
            rel="noopener noreferrer"
            className="node-wikipedia-link"
          >
            <span className="flex items-center justify-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              Wikipedia
            </span>
          </a>
        </div>
      </div>
    </div>
  </>
  );
}

export const MemoizedNodeDetailPanel = memo(NodeDetailPanel);

function MetricCard({ label, value, color }: { label: string; value: string; color?: string }) {
  const colorClasses: Record<string, string> = {
    cyan: 'text-cyan-400',
    purple: 'text-purple-400',
    pink: 'text-pink-400',
    yellow: 'text-yellow-400',
  };
  
  return (
    <div className="glass rounded-xl p-3">
      <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-sm font-semibold truncate ${color ? colorClasses[color] : 'text-white'}`} title={value}>
        {value}
      </div>
    </div>
  );
}

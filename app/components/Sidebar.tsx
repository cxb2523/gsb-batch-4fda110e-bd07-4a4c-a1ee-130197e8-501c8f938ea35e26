'use client';

import { memo, useMemo, useState } from 'react';
import type { CrawlResult } from '@/types/graph';
import { getCommunityColor } from '@/lib/graphAnalysis';
import { buildAdjacency } from '@/lib/adjacency';

interface SidebarProps {
  data: CrawlResult;
  onNodeSelect: (nodeId: string) => void;
  onCommunitySelect: (communityId: number) => void;
  focusedNode: string | null;
  focusedCommunityId?: number | null;
  isOpen?: boolean;
  onClose?: () => void;
  onDesktopClose?: () => void;
}

function Sidebar({ data, onNodeSelect, onCommunitySelect, focusedNode, focusedCommunityId = null, isOpen = false, onClose = () => undefined, onDesktopClose = onClose }: SidebarProps) {
  const [activeTab, setActiveTab] = useState<'pagerank' | 'bridges' | 'communities'>('pagerank');
  const [filterQuery, setFilterQuery] = useState('');
  const selectedNode = data.nodes.find((node) => node.id === focusedNode) ?? null;
  const meaningfulCommunities = data.communities.filter((community) => community.size > 1);
  
  const topPages = useMemo(
    () => [...data.nodes]
      .filter((node) => !filterQuery || node.title.toLocaleLowerCase().includes(filterQuery.toLocaleLowerCase()))
      .sort((a, b) => b.pagerank - a.pagerank)
      .slice(0, 10),
    [data.nodes, filterQuery]
  );
  const bridges = useMemo(
    () => [...data.nodes]
      .filter((node) => node.id !== data.seedId)
      .filter((node) => !filterQuery || node.title.toLocaleLowerCase().includes(filterQuery.toLocaleLowerCase()))
      .sort((a, b) => b.betweenness - a.betweenness)
      .slice(0, 10),
    [data.nodes, data.seedId, filterQuery],
  );
  const maxPageRank = useMemo(() => Math.max(...data.nodes.map((node) => node.pagerank), 0), [data.nodes]);
  const maxBetweenness = useMemo(() => Math.max(...data.nodes.map((node) => node.betweenness), 0), [data.nodes]);
  const filterNodes = activeTab === 'bridges' ? bridges : topPages;

  const connectedPages = useMemo(() => {
    if (!selectedNode) return [];
    const nodesById = new Map(data.nodes.map((node) => [node.id, node]));
    return (buildAdjacency(data.edges).get(selectedNode.id) ?? [])
      .map((nodeId) => nodesById.get(nodeId))
      .filter((node): node is typeof data.nodes[number] => Boolean(node))
      .slice(0, 8);
  }, [data, selectedNode]);

  return (
    <aside className={`atlas-sidebar mobile-sheet reduce-effects w-80 glass-strong border-l border-white/10 flex flex-col overflow-hidden ${isOpen ? 'mobile-sheet-open' : ''}`}>
      {/* Header */}
      <div className="px-4 py-4 border-b border-white/10">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
          <div className="atlas-brand-mark w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-purple-500 p-[2px]">
            <div className="atlas-brand-inner w-full h-full bg-slate-900 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
              </svg>
            </div>
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">WikiCrawl</h2>
            <p className="text-xs text-atlas-muted">Atlas of Wikipedia knowledge</p>
          </div>
          </div>
          <button type="button" onClick={() => {
            if (window.matchMedia('(min-width: 701px)').matches) onDesktopClose();
            else onClose();
          }} className="atlas-sidebar-close atlas-icon-button" aria-label="Close atlas sidebar" title="Close Atlas">×</button>
        </div>
        {selectedNode ? (
          <div className="atlas-context">
            <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-400 mb-2">Current location</p>
            <h3 className="text-lg font-semibold text-white leading-tight">{selectedNode.title}</h3>
            <p className="mt-2 text-xs text-atlas-muted">
              {connectedPages.length} connections · depth {selectedNode.depth >= 0 ? selectedNode.depth : '?'}
            </p>
          </div>
        ) : (
          <div className="atlas-context">
            <p className="text-sm text-slate-300">Explore the map.</p>
            <p className="mt-1 text-xs text-atlas-dim">{data.nodes.length} pages · {data.edges.length} connections</p>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-white/10">
        <button
          type="button"
          aria-label="Show top pages"
          aria-pressed={activeTab === 'pagerank'}
          onClick={() => setActiveTab('pagerank')}
          className={`flex-1 px-4 py-3 text-sm font-medium transition-all ${
            activeTab === 'pagerank'
              ? 'text-white bg-gradient-to-b from-cyan-500/20 to-transparent'
              : 'text-slate-400 hover:text-white hover:bg-white/5'
          }`}
        >
          <span className="flex items-center justify-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
            Top Pages
          </span>
        </button>
        <button
          type="button"
          aria-label="Show bridges"
          aria-pressed={activeTab === 'bridges'}
          onClick={() => setActiveTab('bridges')}
          className={`flex-1 px-4 py-3 text-sm font-medium transition-all ${
            activeTab === 'bridges' ? 'text-white bg-gradient-to-b from-cyan-500/20 to-transparent' : 'text-slate-400 hover:text-white hover:bg-white/5'
          }`}
        >
          Bridges
        </button>
        <button
          type="button"
          aria-label="Show clusters"
          aria-pressed={activeTab === 'communities'}
          onClick={() => setActiveTab('communities')}
          disabled={meaningfulCommunities.length === 0}
          className={`flex-1 px-4 py-3 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
            activeTab === 'communities'
              ? 'text-white bg-gradient-to-b from-purple-500/20 to-transparent'
              : 'text-slate-400 hover:text-white hover:bg-white/5'
          }`}
        >
          <span className="flex items-center justify-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            Clusters
          </span>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {activeTab !== 'communities' ? (
          <>
            <label htmlFor="sidebar-node-filter" className="mb-2 block text-xs font-medium uppercase tracking-wide text-atlas-muted">
              Filter pages
            </label>
            <input
              id="sidebar-node-filter"
              type="search"
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setFilterQuery('');
                if (event.key === 'Enter' && filterNodes[0]) onNodeSelect(filterNodes[0].id);
              }}
              placeholder="Search this graph"
              className="mb-3 w-full rounded border border-white/10 bg-white/5 px-2.5 py-2 text-sm text-white placeholder:text-atlas-dim"
            />
            <div className="space-y-1">
            {filterNodes.map((node, index) => {
              const value = activeTab === 'bridges' ? node.betweenness : node.pagerank;
              const maximum = activeTab === 'bridges' ? maxBetweenness : maxPageRank;
              return (
              <button
                key={node.id}
                type="button"
                aria-pressed={focusedNode === node.id}
                onClick={() => onNodeSelect(node.id)}
                className={`atlas-node-row w-full text-left px-3 py-3 rounded-xl mb-1 transition-all group ${
                  focusedNode === node.id
                    ? 'bg-gradient-to-r from-cyan-500 to-purple-500 text-white shadow-lg shadow-cyan-500/20'
                    : 'hover:bg-white/5 text-slate-300'
                }`}
              >
                <div className="flex items-center gap-3">
                  {activeTab === 'pagerank' && (
                    <span className="w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold bg-slate-700/50 text-atlas-dim">{index + 1}</span>
                  )}
                  <span className="flex-1 truncate text-sm font-medium">{node.title}</span>
                  {node.id === data.seedId && <span className="text-[10px] text-yellow-400">Seed</span>}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex-1 h-1 bg-slate-700 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-cyan-500 to-purple-500 rounded-full transition-all" style={{ width: `${maximum > 0 ? (value / maximum) * 100 : 0}%` }} />
                  </div>
                  <span className="text-[10px] opacity-60">{value.toFixed(3)}</span>
                </div>
              </button>
              );
            })}
            </div>
          </>
        ) : (
          <div className="space-y-1">
            {meaningfulCommunities.slice(0, 15).map((community) => (
              <button
                key={community.id}
                type="button"
                aria-pressed={focusedCommunityId === community.id}
                onClick={() => onCommunitySelect(community.id)}
                className="atlas-community-row w-full text-left px-3 py-3 rounded-xl mb-1 hover:bg-white/5 text-slate-300 transition-all group card-hover"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{
                      backgroundColor: getCommunityColor(community.id, data.communities.length),
                      boxShadow: `0 0 8px ${getCommunityColor(community.id, data.communities.length)}`
                    }}
                  />
                  <span className="flex-1 truncate text-sm font-medium group-hover:text-white">
                    {community.label}
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-xs bg-purple-500/20 text-purple-400">
                    {community.size}
                  </span>
                </div>
                <div className="mt-2 text-[11px] text-atlas-dim truncate pl-6">
                  {community.topPages.slice(0, 3).join(' • ')}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedNode && connectedPages.length > 0 && (
        <div className="atlas-related border-t border-white/10 px-4 py-4">
          <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-slate-500">Connected topics</p>
          <div className="space-y-1">
            {connectedPages.slice(0, 5).map((node) => (
              <button
                key={node.id}
                onClick={() => onNodeSelect(node.id)}
                className="block w-full truncate text-left text-xs text-slate-300 transition-colors hover:text-cyan-300"
              >
                {node.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="atlas-footer p-4 border-t border-white/10">
          <p className="text-[11px] text-atlas-dim text-center">
          Crawled {new Date(data.crawledAt).toLocaleDateString()}
        </p>
        <div className="mt-3 flex justify-center gap-3 text-[11px]">
          <a className="text-slate-400 transition-colors hover:text-cyan-300" href="mailto:jainadityavardhan@gmail.com?subject=WikiCrawl%20Feedback">Feedback</a>
          <a className="text-slate-400 transition-colors hover:text-cyan-300" href="https://www.linkedin.com/in/adityavardhan-jain/" target="_blank" rel="noopener noreferrer" aria-label="Adityavardhan Jain on LinkedIn">LinkedIn</a>
          <a className="text-slate-400 transition-colors hover:text-cyan-300" href="https://github.com/Adityavardhanjain" target="_blank" rel="noopener noreferrer" aria-label="Adityavardhan Jain on GitHub">GitHub</a>
        </div>
        <p className="mt-2 text-center text-[10px] text-atlas-dim">Created by Adityavardhan Jain</p>
      </div>
    </aside>
  );
}

export const MemoizedSidebar = memo(Sidebar);

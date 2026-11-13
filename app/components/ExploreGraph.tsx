import Link from 'next/link';
import type { ExploreGraphData } from '@/lib/exploreData';
import { titleToUrl } from '@/lib/wikipedia';

export function ExploreGraph({ data, topicTitle }: { data: ExploreGraphData | null; topicTitle: string }) {
  if (!data) {
    return (
      <div className="explore-graph-empty">
        <p>A saved Wikipedia graph preview is not available for this topic yet.</p>
        <p>Start a live crawl to build a current graph from Wikipedia links.</p>
      </div>
    );
  }

  if (data.edges.length === 0) {
    return (
      <div className="explore-graph-empty">
        <p>This saved crawl contains {data.nodes.length} pages, but no links between the sampled pages were captured.</p>
        <p>A live crawl with a different page limit may reveal a different neighborhood.</p>
        <ul className="explore-node-list" aria-label="Pages in this saved crawl">
          {data.nodes.map((node) => <li key={node.id}><Link href={titleToUrl(node.title)} target="_blank" rel="noreferrer">{node.title}<span aria-hidden="true"> ↗</span></Link></li>)}
        </ul>
      </div>
    );
  }

  const center = { x: 300, y: 220 };
  const outerNodes = data.nodes.filter((node) => node.id !== data.seedId);
  const positions = new Map<string, { x: number; y: number }>([[data.seedId, center]]);
  outerNodes.forEach((node, index) => {
    const angle = (index / Math.max(outerNodes.length, 1)) * Math.PI * 2 - Math.PI / 2;
    positions.set(node.id, {
      x: center.x + Math.cos(angle) * 168,
      y: center.y + Math.sin(angle) * 154,
    });
  });

  return (
    <div className="explore-graph-wrap">
      <svg className="explore-graph-svg" viewBox="0 0 600 440" role="img" aria-label={`Saved Wikipedia link graph for ${topicTitle}`} aria-labelledby="graph-title graph-description">
        <title id="graph-title">Wikipedia article link graph</title>
        <desc id="graph-description">A graph made from {data.nodes.length} Wikipedia article pages and {data.edges.length} directed links. The linked page list follows.</desc>
        <defs>
          <marker id="explore-arrow" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L7,3.5 L0,7 z" fill="#8f9186" />
          </marker>
        </defs>
        {data.edges.map((edge) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) return null;
          return <line key={`${edge.source}-${edge.target}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} markerEnd="url(#explore-arrow)" />;
        })}
        {data.nodes.map((node) => {
          const position = positions.get(node.id);
          if (!position) return null;
          const isSeed = node.id === data.seedId;
          return <circle key={node.id} cx={position.x} cy={position.y} r={isSeed ? 12 : 7} className={isSeed ? 'is-seed' : ''} />;
        })}
      </svg>
      <p className="explore-graph-caption">A saved crawl of <strong>{topicTitle}</strong>: {data.nodes.length} pages and {data.edges.length} directed Wikipedia links.</p>
      <ul className="explore-node-list" aria-label="Pages in this saved graph">
        {data.nodes.map((node) => (
          <li key={node.id}>
            <Link href={titleToUrl(node.title)} target="_blank" rel="noreferrer">{node.title}<span aria-hidden="true"> ↗</span></Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
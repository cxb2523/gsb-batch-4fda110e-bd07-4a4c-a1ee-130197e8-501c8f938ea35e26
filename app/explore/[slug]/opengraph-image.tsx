import { ImageResponse } from 'next/og';
import { getExploreTopic } from '@/lib/exploreTopics';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'A WikiCrawl topic map of Wikipedia article links';

export default async function ExploreOpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const topic = getExploreTopic(slug);
  const title = topic?.title ?? 'Explore Wikipedia';

  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 64, backgroundColor: '#101311', color: '#e9e5d8', fontFamily: 'sans-serif', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', right: 70, top: 40, width: 460, height: 460, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ position: 'absolute', width: 350, height: 350, border: '1px solid rgba(119,201,189,.42)', borderRadius: 175 }} />
        <div style={{ position: 'absolute', width: 230, height: 230, border: '1px solid rgba(215,243,107,.34)', borderRadius: 115 }} />
        <div style={{ position: 'absolute', width: 18, height: 18, left: 221, top: 221, borderRadius: 9, backgroundColor: '#ff765f' }} />
        <div style={{ position: 'absolute', width: 12, height: 12, left: 108, top: 125, borderRadius: 6, backgroundColor: '#77c9bd' }} />
        <div style={{ position: 'absolute', width: 12, height: 12, right: 78, top: 165, borderRadius: 6, backgroundColor: '#d7f36b' }} />
        <div style={{ position: 'absolute', width: 12, height: 12, left: 119, bottom: 84, borderRadius: 6, backgroundColor: '#77c9bd' }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 760 }}>
        <div style={{ color: '#d7f36b', fontFamily: 'monospace', fontSize: 20 }}>{'/// WIKIPEDIA, MAPPED'}</div>
        <div style={{ marginTop: 44, fontSize: 76, fontWeight: 600, lineHeight: 1.04 }}>{title}</div>
        <div style={{ marginTop: 24, color: '#b8b7a8', fontSize: 28, lineHeight: 1.4 }}>Explore this Wikipedia topic as an interactive link graph.</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid rgba(233,229,216,.22)', paddingTop: 20, color: '#d7f36b', fontFamily: 'monospace', fontSize: 18 }}>
        <span>WIKICRAWL</span>
        <span>SEARCH → CRAWL → EXPLORE</span>
      </div>
    </div>,
    size,
  );
}
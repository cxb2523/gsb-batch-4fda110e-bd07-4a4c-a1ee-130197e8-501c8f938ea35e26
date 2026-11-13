import { ImageResponse } from 'next/og';

export const alt = 'WikiCrawl: an interactive map of Wikipedia links';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 64, background: '#111613', color: '#edf0e7', fontFamily: 'Arial, sans-serif', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', right: -90, top: -110, width: 560, height: 560, border: '1px solid rgba(119,201,189,.24)', borderRadius: 280, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 360, height: 360, border: '1px solid rgba(216,242,122,.24)', borderRadius: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 150, height: 150, border: '1px solid rgba(244,134,112,.5)', borderRadius: 75, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f48670', fontSize: 38 }}>W</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ color: '#77c9bd', fontFamily: 'monospace', fontSize: 20, letterSpacing: 2 }}>{'/// FIELD NOTES · WIKIPEDIA, MAPPED'}</div>
        <div style={{ maxWidth: 770, marginTop: 38, fontSize: 76, fontWeight: 600, lineHeight: 1.04 }}>Follow an idea beyond its first link.</div>
        <div style={{ maxWidth: 650, marginTop: 24, color: '#bdc6bb', fontSize: 26, lineHeight: 1.4 }}>Explore pages, patterns, and unexpected connections in an interactive graph.</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid rgba(222,232,218,.2)', paddingTop: 20, color: '#d8f27a', fontFamily: 'monospace', fontSize: 18 }}>
        <span>WIKICRAWL</span>
        <span>SEARCH → CRAWL → EXPLORE</span>
      </div>
    </div>,
    size,
  );
}

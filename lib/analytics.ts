const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

interface AnalyticsEvent {
  event_name: 'crawl_started' | 'crawl_completed' | 'crawl_failed';
  session_id?: string;
  source?: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
}

export async function trackEvent(event: AnalyticsEvent): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Analytics environment variables are missing');
    return;
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/analytics_events`,
      {
        method: 'POST',
       headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
        body: JSON.stringify({
          event_name: event.event_name,
          session_id: event.session_id ?? null,
          source: event.source ?? null,
          duration_ms: event.duration_ms ?? null,
          metadata: event.metadata ?? {},
        }),
      },
    );

    if (!response.ok) {
      console.error(
        'Analytics event failed:',
        response.status,
        await response.text(),
      );
    }
  } catch (error) {
    // Analytics must never break the actual WikiCrawl request.
    console.error('Analytics error:', error);
  }
}

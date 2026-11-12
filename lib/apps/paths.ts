export const appPath = (appId: string) => `/apps/${appId}`;

export const dashboardPath = (appId: string, dashboardId: string) =>
  `/apps/${appId}/dashboards/${dashboardId}`;

/** Which app and dashboard a pathname points at, if any. */
export function parseAppPath(pathname: string | null): { appId?: string; dashboardId?: string } {
  const match = pathname?.match(/^\/apps\/([^/]+)(?:\/dashboards\/([^/]+))?/);
  return { appId: match?.[1], dashboardId: match?.[2] };
}

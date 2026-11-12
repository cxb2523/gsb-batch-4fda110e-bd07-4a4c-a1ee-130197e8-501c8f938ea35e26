import "server-only";

import type { ConnectionType } from "./catalog";
import { bigquerySource } from "./bigquery/source";
import { clickhouseSource } from "./clickhouse/source";
import { ga4Source } from "./ga4/source";
import { mcpSource } from "./mcp/source";
import { mysqlSource } from "./mysql/source";
import { postgresSource } from "./postgres/source";
import { posthogSource } from "./posthog/source";
import { searchConsoleSource } from "./searchconsole/source";
import type { ConnectionSource } from "./types";

/**
 * Every data source, server side. Generic code finds a source's credential
 * rules, checks, errors and tools here and nowhere else.
 */
const SOURCES: Record<ConnectionType, ConnectionSource> = {
  posthog: posthogSource as unknown as ConnectionSource,
  postgres: postgresSource as unknown as ConnectionSource,
  mysql: mysqlSource as unknown as ConnectionSource,
  clickhouse: clickhouseSource as unknown as ConnectionSource,
  bigquery: bigquerySource as unknown as ConnectionSource,
  ga4: ga4Source as unknown as ConnectionSource,
  searchconsole: searchConsoleSource as unknown as ConnectionSource,
  mcp: mcpSource as unknown as ConnectionSource,
};

export function sourceFor(type: ConnectionType): ConnectionSource {
  return SOURCES[type];
}

export const ALL_SOURCES: readonly ConnectionSource[] = Object.values(SOURCES);

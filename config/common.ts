import type { CommonSettings } from "./settings";

/** Settings that are the same locally and in production. */
export const common: CommonSettings = {
  openui: {
    apiUrl: "https://api.thesys.dev",
    gatewayUrl: "https://api.thesys.dev/v1/embed",
    model: "anthropic/claude-sonnet-5.5",
    maxAgentRounds: 24,
  },
  posthog: { queryTimeoutMs: 50_000, checkTimeoutMs: 15_000, maxRows: { agent: 200, dashboard: 10_000 } },
  kms: { region: "us-east-1" },
  postgres: { connectTimeoutMs: 5_000, statementTimeoutMs: 15_000, maxRows: { agent: 200, dashboard: 10_000 } },
  mysql: { connectTimeoutMs: 5_000, statementTimeoutMs: 15_000, maxRows: { agent: 200, dashboard: 10_000 } },
  clickhouse: {
    queryTimeoutMs: 30_000,
    checkTimeoutMs: 10_000,
    maxRows: { agent: 200, dashboard: 10_000 },
    maxResponseBytes: 20 * 1024 * 1024,
  },
  bigquery: {
    queryTimeoutMs: 45_000,
    checkTimeoutMs: 15_000,
    maxRows: { agent: 200, dashboard: 10_000 },
    // 10 GiB: about six US cents at on-demand prices.
    maxBytesBilled: 10 * 1024 ** 3,
  },
  searchConsole: { requestTimeoutMs: 30_000, maxRows: { agent: 200, dashboard: 10_000 } },
  googleAnalytics: { requestTimeoutMs: 30_000, maxRows: { agent: 200, dashboard: 10_000 } },
  mcp: { requestTimeoutMs: 30_000, maxResponseBytes: 2 * 1024 * 1024, maxTools: 200, maxTextChars: 100_000 },
  // Demo data: the "Demo Data" Neon project, shared by several apps. Read-only
  // for us: we connect only as its read-only role (DEMO_DATABASE_PASSWORD) and
  // never migrate, branch or write to it. Our own data is DATABASE_URL's.
  demoData: {
    neonProject: "Demo Data",
    datasets: [
      {
        key: "retail",
        name: "Retail sales",
        description:
          "A sample retail business: orders, order lines, products, customers, promotions, refunds and sales targets. " +
          "Raw tables are in the retail schema; the analytics schema has ready-made reporting views " +
          "(daily_sales_by_region, monthly_business_kpis, customer_summary, target_attainment, …). " +
          "Prefer the analytics views for standard metrics and use the retail tables for anything they don't cover.",
        postgres: {
          // Neon's pooler: OpenDashboards opens a connection per query.
          host: "ep-wispy-hill-bbojf1nh-pooler.c-15.us-east-1.aws.neon.tech",
          port: 5432,
          database: "retail_sales",
          user: "prism_demo_reader",
          sslMode: "verify-full",
        },
        prompts: [
          "An executive overview: revenue, orders, average order value and margin by month",
          "Sales by region and product category over the last 90 days",
          "How much promotions and refunds cost us each month",
        ],
      },
    ],
  },
};

import { CLICKHOUSE_DEFAULT_PORT } from "@/lib/sources/clickhouse/catalog";
import { projectIdOfKey } from "@/lib/sources/google/credential";
import { MYSQL_DEFAULT_PORT, parseMysqlUrl } from "@/lib/sources/mysql/catalog";

/**
 * What the generic connection form asks for, per source. Client-safe. The
 * server validates everything again with the source's own schemas.
 */

export type FieldSpec = {
  name: string;
  label: string;
  kind: "text" | "password" | "number" | "textarea" | "ssl";
  placeholder?: string;
  description?: string;
  optional?: boolean;
  initial?: string;
  /** Half width, side by side with the next half-width field. */
  half?: boolean;
  /** A file input that fills this field (e.g. a JSON key). */
  fileAccept?: string;
};

export type FormSpec = {
  title: string;
  description: string;
  fields: FieldSpec[];
  /** The secret: a password or a key. The only field shown when replacing it. */
  credential: FieldSpec;
  replaceTitle: string;
  replaceAction: string;
  /** A connection URL people may paste instead of filling in the fields. */
  paste?: { label: string; placeholder: string; parse: (text: string) => Record<string, string | number> | null };
  /** Derives other fields when one changes, e.g. the project from a pasted key. */
  derive?: (name: string, value: string, values: Record<string, string>) => Record<string, string>;
  help?: { summary: string; intro: string; code?: string; steps?: string[] };
  /** What "plaintext" storage mode warns about. */
  secretNoun: string;
};

/** A password a public, read-only server may not need. */
const NO_PASSWORD_OK: FieldSpec = {
  name: "password",
  label: "Password",
  kind: "password",
  optional: true,
  description: "Leave empty for a server that doesn't need one.",
};

/** A service account's JSON key: what every Google source takes. */
const SERVICE_ACCOUNT_KEY: FieldSpec = {
  name: "serviceAccountKey",
  label: "Service account key (JSON)",
  kind: "textarea",
  placeholder: '{ "type": "service_account", "client_email": "…", "private_key": "…" }',
  fileAccept: "application/json,.json",
  description: "Only the account's email and private key are kept, encrypted.",
};

const CREATE_SERVICE_ACCOUNT = [
  "In the Google Cloud console: IAM & Admin → Service accounts → Create service account, e.g. dashboards-reader. It needs no project roles.",
  "Open the account → Keys → Add key → Create new key → JSON.",
];

export const SOURCE_FORMS: Record<"mysql" | "clickhouse" | "bigquery" | "ga4" | "searchconsole" | "mcp", FormSpec> = {
  mysql: {
    title: "Connect MySQL",
    description: "OpenDashboards runs read-only queries against your MySQL or MariaDB database to build dashboards.",
    fields: [
      { name: "name", label: "Name", kind: "text", placeholder: "Production MySQL" },
      { name: "host", label: "Host", kind: "text", placeholder: "db.example.com" },
      { name: "port", label: "Port", kind: "number", initial: String(MYSQL_DEFAULT_PORT), half: true },
      { name: "database", label: "Database", kind: "text", placeholder: "shop", half: true },
      { name: "user", label: "User", kind: "text", placeholder: "dashboards_reader" },
      { name: "sslMode", label: "SSL", kind: "ssl", initial: "verify-full" },
    ],
    credential: NO_PASSWORD_OK,
    replaceTitle: "Change password",
    replaceAction: "Test & change",
    paste: {
      label: "Connection string (optional)",
      placeholder: "mysql://user:password@host:3306/database",
      parse: (text) => parseMysqlUrl(text) as Record<string, string | number> | null,
    },
    help: {
      summary: "Use a read-only user (recommended)",
      intro: "OpenDashboards only reads, but a user that can't write is safer. Run this as an admin, then connect as dashboards_reader:",
      code: `CREATE USER 'dashboards_reader'@'%' IDENTIFIED BY '…' REQUIRE SSL;
GRANT SELECT, SHOW VIEW ON your_db.* TO 'dashboards_reader'@'%';`,
    },
    secretNoun: "passwords",
  },
  clickhouse: {
    title: "Connect ClickHouse",
    description: "OpenDashboards runs read-only queries against ClickHouse over HTTPS to build dashboards.",
    fields: [
      { name: "name", label: "Name", kind: "text", placeholder: "Events warehouse" },
      { name: "host", label: "Host", kind: "text", placeholder: "abc123.us-east-1.aws.clickhouse.cloud" },
      {
        name: "port",
        label: "HTTPS port",
        kind: "number",
        initial: String(CLICKHOUSE_DEFAULT_PORT),
        half: true,
      },
      { name: "database", label: "Database", kind: "text", initial: "default", half: true },
      { name: "user", label: "User", kind: "text", placeholder: "dashboards_reader" },
      { name: "sslMode", label: "SSL", kind: "ssl", initial: "verify-full" },
    ],
    credential: NO_PASSWORD_OK,
    replaceTitle: "Change password",
    replaceAction: "Test & change",
    help: {
      summary: "Use a read-only user (recommended)",
      intro:
        "OpenDashboards runs every query read-only with its own time and row limits, but a user that can only SELECT is safer. Run this as an admin (no readonly profile setting: OpenDashboards sets it per query):",
      code: `CREATE USER dashboards_reader IDENTIFIED BY '…';
GRANT SELECT ON your_db.* TO dashboards_reader;`,
    },
    secretNoun: "passwords",
  },
  bigquery: {
    title: "Connect BigQuery",
    description: "OpenDashboards runs read-only queries in your Google Cloud project to build dashboards. Queries are billed to that project.",
    fields: [
      { name: "name", label: "Name", kind: "text", placeholder: "Analytics warehouse" },
      { name: "projectId", label: "Project ID", kind: "text", placeholder: "my-project-123", half: true, description: "Runs and pays for the queries." },
      { name: "location", label: "Location", kind: "text", placeholder: "US", optional: true, half: true, description: "Optional. US, EU, us-central1…" },
    ],
    credential: {
      name: "serviceAccountKey",
      label: "Service account key (JSON)",
      kind: "textarea",
      placeholder: '{ "type": "service_account", "client_email": "…", "private_key": "…" }',
      fileAccept: "application/json,.json",
      description: "Only the account's email and private key are kept, encrypted.",
    },
    replaceTitle: "Replace key",
    replaceAction: "Test & replace",
    derive: (name, value, values): Record<string, string> => {
      const projectId = name === "serviceAccountKey" && !values.projectId ? projectIdOfKey(value) : null;
      return projectId ? { projectId } : {};
    },
    help: {
      summary: "How to create a read-only service account",
      intro: "In the Google Cloud console:",
      steps: [
        "IAM & Admin → Service accounts → Create service account, e.g. dashboards-reader.",
        "Grant it BigQuery Job User (to run queries) and BigQuery Data Viewer (to read data), on the project or only on the datasets OpenDashboards should see.",
        "Open the account → Keys → Add key → Create new key → JSON, and paste or upload the file here.",
      ],
    },
    secretNoun: "keys",
  },
  ga4: {
    title: "Connect Google Analytics",
    description: "OpenDashboards reads reports from your GA4 property, read-only, to build dashboards.",
    fields: [
      { name: "name", label: "Name", kind: "text", placeholder: "Website analytics" },
      {
        name: "propertyId",
        label: "Property ID",
        kind: "text",
        placeholder: "123456789",
        description: "In GA4: Admin → Property settings. Numbers only, not the G- measurement ID.",
      },
    ],
    credential: SERVICE_ACCOUNT_KEY,
    replaceTitle: "Replace key",
    replaceAction: "Test & replace",
    help: {
      summary: "How to give OpenDashboards read-only access",
      intro: "A service account reads the property on OpenDashboards' behalf:",
      steps: [
        ...CREATE_SERVICE_ACCOUNT,
        "In the same Cloud project, enable the Google Analytics Data API (APIs & Services → Library).",
        "In GA4: Admin → Property access management → add the account's email as a Viewer.",
      ],
    },
    secretNoun: "keys",
  },
  searchconsole: {
    title: "Connect Search Console",
    description: "OpenDashboards reads your site's Google Search performance, read-only, to build dashboards.",
    fields: [
      { name: "name", label: "Name", kind: "text", placeholder: "Google Search" },
      {
        name: "siteUrl",
        label: "Property",
        kind: "text",
        placeholder: "sc-domain:example.com",
        description: "As Search Console shows it: sc-domain:example.com for a Domain property, or https://www.example.com/ for a URL prefix.",
      },
    ],
    credential: SERVICE_ACCOUNT_KEY,
    replaceTitle: "Replace key",
    replaceAction: "Test & replace",
    help: {
      summary: "How to give OpenDashboards read-only access",
      intro: "A service account reads the property on OpenDashboards' behalf:",
      steps: [
        ...CREATE_SERVICE_ACCOUNT,
        "In the same Cloud project, enable the Google Search Console API (APIs & Services → Library).",
        "In Search Console: open the property → Settings → Users and permissions → Add user, with the account's email and Restricted permission.",
      ],
    },
    secretNoun: "keys",
  },
  mcp: {
    title: "Connect an MCP server",
    description: "OpenDashboards calls the server's tools to explore data and build dashboards. Only remote servers over HTTPS.",
    fields: [
      { name: "name", label: "Name", kind: "text", placeholder: "Billing MCP" },
      {
        name: "url",
        label: "Server URL",
        kind: "text",
        placeholder: "https://mcp.example.com/mcp",
        description: "The server's Streamable HTTP endpoint. Local (stdio) servers aren't supported.",
      },
      {
        name: "headerName",
        label: "Key header",
        kind: "text",
        initial: "Authorization",
        description: "Authorization sends the key as Bearer <key>. Use another header, like X-API-Key, if the server expects one.",
      },
    ],
    credential: {
      name: "apiKey",
      label: "API key",
      kind: "password",
      optional: true,
      description: "Leave empty for a public server. Prefer a key that can only read: dashboards call tools every time they open.",
    },
    replaceTitle: "Replace key",
    replaceAction: "Test & replace",
    secretNoun: "keys",
  },
};

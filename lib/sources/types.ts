import type { z } from "zod";

import type { ConnectionStatus } from "@/lib/db/schema";

/**
 * The contract every data source implements (PostHog, Postgres, …). A source
 * lives in lib/sources/<type>/ and owns everything type-specific: its
 * settings, its credential, how it's tested, how its errors read, and the
 * tools the agent and dashboards use. Generic code (the connection service,
 * the agent, dashboards) only ever goes through this interface.
 *
 * Split in two so browser code can describe connections without pulling in
 * drivers: the catalog is client-safe; the source adds the server parts.
 */

/** How a connection reads in lists and pickers. */
export type SourceDescription = {
  /** "PostHog · US Cloud", "Postgres". */
  source: string;
  /** For tight spaces: "PostHog US", "Postgres". */
  shortSource: string;
  /** "Project 12345", "analyst@db.example.com:5432/app". */
  detail: string;
  /** The two letters on the source tile. */
  tile: string;
};

/** Client-safe: what a source is and how its settings look. */
export interface SourceCatalog<
  Config extends Record<string, unknown> = Record<string, unknown>,
  Type extends string = string,
> {
  type: Type;
  /** "PostHog". */
  label: string;
  /** One line for the "Available sources" list. */
  blurb: string;
  tile: string;
  /** The settings that aren't secret, stored in data_connections.config. */
  configSchema: z.ZodType<Config>;
  describe(config: Config): SourceDescription;
}

/** Something a successful check found that doesn't stop the connection working. */
export type ConnectionWarning = "can_write";

/** A user-facing error for a form or a toast. `field` is a form field name. */
export type SourceError = { code: string; message: string; field?: string };

/** A saved connection, opened: settings plus the decrypted credential. Server only. */
export type OpenConnection<Config> = { id: string; name: string; config: Config; credential: string };

/** Rows from a query, in the shape both the agent and dashboards read. */
export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  /** More rows matched than were returned. */
  truncated: boolean;
};

/** Who is calling a tool: the chat agent while exploring, or a dashboard on view. */
export type ToolCaller = "agent" | "dashboard";

/**
 * A tool a source offers. Its arguments never include who the user is or a
 * credential: the shared runner (lib/tools) resolves the `connection` id for
 * the signed-in user and hands `execute` an open connection.
 */
export interface SourceTool<Config, Args = Record<string, unknown>> {
  /** Globally unique, prefixed with the source type: "postgres_query". */
  name: string;
  description: string;
  /** The tool's own arguments, without `connection` (the runner adds it). */
  parameters: z.ZodType<Args>;
  /** An example result, so dashboard generation can bind components to its fields. */
  output: unknown;
  /** Which callers may use it. */
  callers: readonly ToolCaller[];
  execute(
    connection: OpenConnection<Config>,
    args: Args,
    options: { signal: AbortSignal; caller: ToolCaller },
  ): Promise<unknown>;
}

/** Server: the catalog plus credential handling, checks, errors and tools. */
export interface ConnectionSource<Config extends Record<string, unknown> = Record<string, unknown>>
  extends SourceCatalog<Config> {
  credential: {
    /** The form field that holds it: "apiKey", "password". */
    field: string;
    schema: z.ZodType<string>;
    /** Binds the sealed secret to its use (KMS encryption context). */
    purpose: string;
    /** What the UI shows instead of it, e.g. "phx_…a1b2". */
    hint(credential: string): string;
  };
  /** Checks the connection works with this credential. Throws on failure. */
  test(config: Config, credential: string, signal?: AbortSignal): Promise<ConnectionWarning[]>;
  /** Turns this source's failures into a user-facing error and the status to record. */
  toError(error: unknown): { error: SourceError; status: Exclude<ConnectionStatus, "ok"> } | null;
  // Each tool has its own argument type; the runner validates them with the tool's schema.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: readonly SourceTool<Config, any>[];
}

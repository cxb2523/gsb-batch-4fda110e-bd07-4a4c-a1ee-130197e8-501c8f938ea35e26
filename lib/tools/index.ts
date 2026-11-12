import "server-only";

import { z } from "zod";

import { getAppService } from "@/lib/apps";
import { fromCheckError } from "@/lib/connections/errors";
import { getConnectionService } from "@/lib/connections";
import { logError, withLogContext } from "@/lib/log";
import { ALL_SOURCES } from "@/lib/sources";
import type { ConnectionType } from "@/lib/sources/catalog";
import type { ConnectionSource, SourceTool, ToolCaller } from "@/lib/sources/types";

/**
 * Turns every source's tools into tools the agent and dashboards can call.
 *
 * Sources write tools as "given an open connection, do X". This runner does
 * the rest, the same way for every source and every caller:
 *   1. validates the arguments against the tool's schema;
 *   2. takes the user and app from the server-side context, never from arguments;
 *   3. opens the `connection` id only if it's this user's, of the tool's type;
 *   4. runs the tool, and on success records that the app uses the connection
 *      (`app_connections`: connections are inferred from use).
 */

/** Who a call is for. Comes from the session and the route, never from the model. */
export type ToolContext = { userId: string; appId: string };

/** A tool ready to run, described for the model. */
export type Tool = {
  name: string;
  description: string;
  /** JSON Schema of the arguments, `connection` included where the tool takes one. */
  parameters: Record<string, unknown>;
  /** An example result, for dashboard generation. */
  output?: unknown;
  callers: readonly ToolCaller[];
  run(args: unknown, context: ToolContext, options: { signal: AbortSignal; caller: ToolCaller }): Promise<unknown>;
};

/** A failure the caller should see (the agent reads it and can try again). */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

const connectionArg = z
  .string()
  .describe("The connection's id, from list_connections.");

function fromSource(source: ConnectionSource, tool: SourceTool<Record<string, unknown>>): Tool {
  const own = tool.parameters as unknown as z.ZodObject;
  const schema = z.object({ connection: connectionArg, ...own.shape });
  return {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(schema),
    output: tool.output,
    callers: tool.callers,
    async run(args, context, { signal, caller }) {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ToolError("bad_args", `Invalid arguments: ${issue?.path.join(".") || "input"}: ${issue?.message}`);
      }
      const { connection: connectionId, ...toolArgs } = parsed.data;

      const connection = await getConnectionService().open(context.userId, connectionId, source.type as ConnectionType);
      if (!connection) throw new ToolError("connection_not_found", `No ${source.label} connection with id ${connectionId}.`);

      // Tool calls in one turn run concurrently, so each gets its own copy of the context.
      const result = await withLogContext({ connection: connection.id }, async () => {
        try {
          return await tool.execute(connection, toolArgs, { signal, caller });
        } catch (error) {
          const known = fromCheckError(error);
          if (known) {
            // The caller gets a short message; keep the cause (network error, PostHog's
            // detail) in the server log, where it can be diagnosed.
            if (known.status === "unavailable") logError(`tools.${tool.name}`, error);
            throw new ToolError(known.error.code, known.error.message);
          }
          logError(`tools.${tool.name}`, error);
          throw new ToolError("internal", "The tool failed unexpectedly.");
        }
      });

      // Inferred from use. A failure to record shouldn't fail the query.
      const recorded = await getAppService().recordConnectionUse(context.userId, context.appId, connection.id);
      if (!recorded.ok && recorded.error.code !== "not_found") logError("tools.recordConnectionUse", recorded.error);
      return result;
    },
  };
}

/** The user's connections, so the agent knows which ids to pass. */
const listConnections: Tool = {
  name: "list_connections",
  description:
    "The user's data connections: id, name, type and what each points at. Pass a connection's id to that source's tools. " +
    "A demo dataset is sample data OpenDashboards provides; its `about` says what's in it and where to look first.",
  parameters: z.toJSONSchema(z.object({})),
  callers: ["agent"],
  async run(_args, context) {
    const connections = await getConnectionService().list(context.userId);
    return connections.map(({ id, name, type, source, detail, status, demo }) => ({
      id,
      name,
      type,
      source,
      detail,
      status,
      ...(demo ? { demo: true, about: demo.description } : {}),
    }));
  },
};

let tools: Tool[] | undefined;

/** Every tool: the shared ones and every source's own. */
export function allTools(): Tool[] {
  tools ??= [
    listConnections,
    ...ALL_SOURCES.flatMap((source) =>
      source.tools.map((tool) => fromSource(source, tool as SourceTool<Record<string, unknown>>)),
    ),
  ];
  return tools;
}

/** The tools a caller may use. */
export function toolsFor(caller: ToolCaller): Tool[] {
  return allTools().filter((tool) => tool.callers.includes(caller));
}

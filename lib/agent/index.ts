import "server-only";

import OpenAI from "openai";
import type { RunnableToolFunctionWithContext } from "openai/lib/RunnableFunction";
import { z } from "zod";

import { config, secrets } from "@/config";
import {
  artifactOf,
  deleteDashboard,
  getDashboardService,
  getDashboards,
  readDashboard,
} from "@/lib/dashboards";
import { track } from "@/lib/analytics";
import { logError } from "@/lib/log";
import spec from "@/lib/dashboards/generated/dashboard.spec.json";
import { ToolError, toolsFor, type ToolContext } from "@/lib/tools";

/**
 * The Build agent: a plain tool loop over OpenUI Gateway. It explores the
 * app's data with every source's agent tools, then creates and edits live
 * dashboards in OpenUI Cloud. The chat itself is Markdown.
 */



/** Model rounds per turn, tool calls included. */
export const maxRounds = () => config().openui.maxAgentRounds;

/** The model that runs the Build agent. */
export const model = () => config().openui.model;

export const SYSTEM_PROMPT = `You are OpenDashboards' dashboard builder. The user is building an app: a set of live dashboards over their own data.

- Explore before you build: find the user's connections with list_connections, look at what data exists, and run queries to check that the numbers you plan to show are real and sensible.
- Build with create_dashboard. To explain or change an existing dashboard, read it first with read_dashboard (find it with list_dashboards), then use edit_dashboard; delete one with delete_dashboard only when the user asks. Describe in the prompt what to show and exactly which tool calls and queries load each part, with the connection id. Dashboards load their data live every time they open.
- Reply in short Markdown. Say what you built and what it shows. Don't paste query results or code unless asked.`;

let gateway: OpenAI | undefined;

/** OpenUI Gateway, as configured: its URL and the THESYS_API_KEY secret. */
export function getGateway(): OpenAI {
  gateway ??= new OpenAI({ baseURL: config().openui.gatewayUrl, apiKey: secrets.thesysApiKey() });
  return gateway;
}

/** What one turn did, for the route to act on afterwards. */
export type TurnContext = ToolContext & { signal: AbortSignal; dashboards: string[] };

type AgentTool = RunnableToolFunctionWithContext<TurnContext>;

/**
 * Every tool the agent may call this turn. A failure goes back to the model
 * as `{ error }`, so it can read it and try again, rather than ending the turn.
 */
export function agentTools(): AgentTool[] {
  const dataTools = toolsFor("agent").map((tool) =>
    define(tool.name, tool.description, tool.parameters, (args, turn) =>
      tool.run(args, turn, { signal: turn.signal, caller: "agent" }),
    ),
  );
  return [...dataTools, listDashboards, readDashboardTool, createDashboard, editDashboard, deleteDashboardTool];
}

function define(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: (args: unknown, turn: TurnContext) => Promise<unknown>,
): AgentTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters,
      parse: (input: string) => JSON.parse(input || "{}") as unknown,
      async function(args: unknown, _runner: unknown, turn: TurnContext) {
        try {
          return await run(args, turn);
        } catch (error) {
          if (turn.signal.aborted) throw error;
          if (error instanceof ToolError) return { error: { code: error.code, message: error.message } };
          logError(`agent.${name}`, error);
          return { error: { code: "internal", message: "The tool failed unexpectedly." } };
        }
      },
    },
  };
}

const listDashboards = define(
  "list_dashboards",
  "The dashboards already in this app: id and title. Pass an id to edit_dashboard to change one.",
  z.toJSONSchema(z.object({})),
  async (_input, turn) =>
    (await getDashboardService().list(turn.userId, turn.appId)).map(({ artifactId, title }) => ({
      dashboard: artifactId,
      title,
    })),
);

/** Enough for any dashboard so far (10–15K characters), without flooding the context. */
const MAX_PROGRAM_CHARS = 60_000;

const libraryComponents = (spec as unknown as { components: Record<string, { signature: string; description: string }> })
  .components;

/** The dashboard library's own description of each component a program uses. */
function componentsUsed(program: string): Record<string, string> {
  const used: Record<string, string> = {};
  for (const [, name] of program.matchAll(/\b([A-Z][A-Za-z0-9]*)\(/g)) {
    const component = libraryComponents[name];
    if (component && !used[name]) used[name] = component.description;
  }
  return used;
}

const readArgs = z.object({
  dashboard: z.string().min(1).max(200).describe("The dashboard's id, from list_dashboards or create_dashboard."),
});

const readDashboardTool = define(
  "read_dashboard",
  "Reads a dashboard in this app: its program in OpenUI Lang, with every section, component, title and the exact query behind each one, plus what each component draws. Read a dashboard before explaining or changing it.",
  z.toJSONSchema(readArgs),
  async (input, turn) => {
    const args = parseArgs(readArgs, input);
    const result = await readDashboard(turn.userId, turn.appId, args.dashboard);
    if (!result.ok) {
      throw result.reason === "not_found"
        ? new ToolError("dashboard_not_found", `No dashboard ${args.dashboard} in this app.`)
        : new ToolError("cloud_failed", "OpenUI Cloud couldn't read the dashboard. Try again.");
    }
    const truncated = result.program.length > MAX_PROGRAM_CHARS;
    return {
      dashboard: args.dashboard,
      title: result.title,
      description: result.description,
      program: truncated ? result.program.slice(0, MAX_PROGRAM_CHARS) : result.program,
      ...(truncated ? { truncated: true } : {}),
      // What each component it uses draws, e.g. that GeoMap is a map with a ranked list.
      components: componentsUsed(result.program),
    };
  },
);

const createArgs = z.object({
  title: z.string().trim().min(1).max(120).describe("The dashboard's title, shown above it and in the sidebar."),
  description: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe("One sentence under the title: what the dashboard shows, over what period or data."),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe(
      "What the dashboard shows, and which tool calls (with the connection id) load each part. " +
        "Leave out its title and description: OpenDashboards draws those above it.",
    ),
});

const createDashboard = define(
  "create_dashboard",
  "Creates a live dashboard in this app, with its title and description. It opens for the user when the turn ends.",
  z.toJSONSchema(createArgs),
  async (input, turn) => {
    const args = parseArgs(createArgs, input);
    const response = await getDashboards().create({ title: args.title, prompt: args.prompt }, turn, {
      signal: turn.signal,
    });
    return remember(response, { title: args.title, description: args.description }, turn);
  },
);

const editArgs = z.object({
  dashboard: z.string().min(1).max(200).describe("The dashboard's id, from list_dashboards or create_dashboard."),
  prompt: z.string().trim().min(1).max(20_000).describe("What to change."),
});

const editDashboard = define(
  "edit_dashboard",
  "Changes what a dashboard in this app shows, in place. Its title and description stay as they are: the user renames dashboards.",
  z.toJSONSchema(editArgs),
  async (input, turn) => {
    const args = parseArgs(editArgs, input);
    const dashboard = await getDashboardService().findByArtifact(turn.userId, args.dashboard);
    if (!dashboard || dashboard.appId !== turn.appId) {
      throw new ToolError("dashboard_not_found", `No dashboard ${args.dashboard} in this app.`);
    }
    const response = await getDashboards().edit({ id: args.dashboard, prompt: args.prompt }, turn, {
      signal: turn.signal,
    });
    return remember(response, null, turn);
  },
);

const deleteArgs = z.object({
  dashboard: z.string().min(1).max(200).describe("The dashboard's id, from list_dashboards or create_dashboard."),
});

const deleteDashboardTool = define(
  "delete_dashboard",
  "Deletes a dashboard from this app, permanently. Use it only when the user asks to delete that dashboard.",
  z.toJSONSchema(deleteArgs),
  async (input, turn) => {
    const args = parseArgs(deleteArgs, input);
    const result = await deleteDashboard(turn.userId, turn.appId, args.dashboard);
    if (!result.ok) {
      throw result.reason === "not_found"
        ? new ToolError("dashboard_not_found", `No dashboard ${args.dashboard} in this app.`)
        : new ToolError("cloud_failed", "OpenUI Cloud couldn't delete the dashboard. Try again.");
    }
    return { deleted: args.dashboard };
  },
);

/**
 * Records a new dashboard against the app with its title and description,
 * then returns OpenUI Cloud's response unchanged as the tool result: it names
 * the dashboard (its `artifact_id`) for the model, and the Build chat hands
 * it to the open dashboard's renderer, which follows the new version as it's
 * built. An edit records nothing: the dashboard keeps its title.
 */
async function remember(
  response: string,
  created: { title: string; description: string } | null,
  turn: TurnContext,
) {
  const artifact = artifactOf(response);
  if (!artifact) {
    logError("agent.dashboard", new Error("OpenUI Cloud's response names no artifact"));
    throw new ToolError("no_artifact", "OpenUI Cloud didn't return a dashboard.");
  }
  if (created) {
    const recorded = await getDashboardService().record(turn.userId, turn.appId, { artifactId: artifact.id, ...created });
    if (!recorded) throw new ToolError("not_found", "This app no longer exists.");
  }
  track(turn.userId, created ? "dashboard_created" : "dashboard_updated", { app_id: turn.appId, dashboard_id: artifact.id });
  turn.dashboards.push(artifact.id);
  return response;
}

function parseArgs<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new ToolError("bad_args", `Invalid arguments: ${issue?.path.join(".") || "input"}: ${issue?.message}`);
}

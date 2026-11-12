import { EventType, type BaseEvent } from "@ag-ui/core";
import { storeChatCompletionHistory } from "@openuidev/server/openai";
import { APIError } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { secrets } from "@/config";
import { track } from "@/lib/analytics";
import { agentTools, getGateway, maxRounds, model, SYSTEM_PROMPT, type TurnContext } from "@/lib/agent";
import { createAgUiTranslator, sse } from "@/lib/agent/ag-ui";
import { chatBodySchema, VIEWING_DASHBOARD, type ChatBody } from "@/lib/agent/messages";
import { getAppService, getThreadService } from "@/lib/apps";
import { getDashboardService } from "@/lib/dashboards";
import { HttpError, readJson, route } from "@/lib/http";
import { addLogContext, logError } from "@/lib/log";
import { count } from "@/lib/metrics";

type Ctx = { params: Promise<{ appId: string }> };

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * One turn of the Build chat. Runs the agent's tool loop over OpenUI Gateway
 * and streams it as AG-UI events (text, tool calls and their results) for
 * the chat's `agUIAdapter`. When the turn ends it's saved to the thread in
 * OpenUI Cloud.
 */
export const POST = route<Ctx>(async (request, user, { params }) => {
  const { appId } = await params;
  addLogContext({ app: appId });
  const parsed = chatBodySchema.safeParse(await readJson(request, { maxBytes: MAX_BODY_BYTES }));
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid chat request");
  const { threadId, messages, context } = parsed.data as ChatBody;
  const runId = typeof parsed.data.runId === "string" ? parsed.data.runId : crypto.randomUUID();
  addLogContext({ thread: threadId, run: runId });

  const threads = getThreadService();
  if (!(await threads.belongsTo(user.id, appId, threadId))) throw new HttpError(404, "Thread not found");

  // What's on screen, if it's one of this app's dashboards: "this dashboard" means that one.
  const viewingId = context?.find((entry) => entry.description === VIEWING_DASHBOARD)?.value;
  const viewing = viewingId
    ? (await getDashboardService().list(user.id, appId)).find((row) => row.artifactId === viewingId)
    : undefined;
  const system: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM_PROMPT }];
  // The data sources the user put in this app: the agent works from these unless asked otherwise.
  const app = await getAppService().get(user.id, appId);
  if (app?.connections.length) {
    const list = app.connections.map((connection) => `${connection.name} (${connection.type}, id ${connection.id})`).join("; ");
    system.push({
      role: "system",
      content: `This app's data sources: ${list}. Use these unless the user asks for another of their connections.`,
    });
  }
  if (viewing) {
    system.push({
      role: "system",
      content: `The user is looking at the dashboard "${viewing.title}" (id ${viewing.artifactId}). "This dashboard" means that one.`,
    });
  }

  const encoder = new TextEncoder();
  const turn: TurnContext = { userId: user.id, appId, signal: request.signal, dashboards: [] };

  const startedAt = Date.now();
  const trackTurn = (outcome: string, cause: string, turnMessages: ChatCompletionMessageParam[]) => {
    const results = turnMessages.filter((message) => message.role === "tool");
    track(user.id, "chat_turn_finished", {
      app_id: appId,
      outcome,
      cause,
      duration_ms: Date.now() - startedAt,
      tool_calls: results.length,
      tool_errors: results.filter((message) => typeof message.content === "string" && message.content.startsWith('{"error":')).length,
      dashboards_changed: turn.dashboards.length,
    });
  };

  const body = new ReadableStream({
    async start(controller) {
      const emit = (event: BaseEvent) => controller.enqueue(encoder.encode(sse(event)));
      const translate = createAgUiTranslator(emit);
      emit({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);

      const runner = getGateway().chat.completions.runTools(
        {
          model: model(),
          messages: [...system, ...messages],
          tools: agentTools(),
          toolContext: turn,
          stream: true,
        },
        { signal: request.signal, maxChatCompletions: maxRounds() },
      );
      runner.on("chunk", (chunk) => translate.chunk(chunk));
      runner.on("message", (message) => translate.message(message));

      // The new turn: the user's message, then every message the loop added.
      const newMessages = () => runner.messages.slice(system.length - 1 + messages.length) as ChatCompletionMessageParam[];

      try {
        await runner.done();
        translate.finish();
        emit({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
        count("opendashboards.chat.turn", { outcome: "completed", cause: "none" });
      } catch (error) {
        if (request.signal.aborted) {
          count("opendashboards.chat.turn", { outcome: "cancelled", cause: "none" });
          trackTurn("cancelled", "none", newMessages());
          controller.close();
          return; // Cancelled: save nothing.
        }
        logError("chat.turn", error);
        const failure = turnFailure(error);
        count("opendashboards.chat.turn", { outcome: "failed", cause: failure.cause });
        trackTurn("failed", failure.cause, newMessages());
        translate.finish();
        emit({ type: EventType.RUN_ERROR, message: failure.message } as BaseEvent);
        controller.close();
        return; // Failed: save nothing.
      }

      // Saved before the stream closes: a Vercel Function can stop once its response ends.
      const turnMessages = newMessages();
      trackTurn("completed", "none", turnMessages);
      try {
        await storeChatCompletionHistory({
          apiKey: secrets.thesysApiKey() ?? "",
          conversationId: threadId,
          messages: turnMessages,
        });
        await threads.touch(user.id, appId, threadId);
      } catch (error) {
        logError("chat.save", error);
      }
      controller.close();
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
  });
});

/** What the chat shows when a turn fails, OpenUI Gateway's refusals by name, and a label for alerts. */
function turnFailure(error: unknown): { cause: string; message: string } {
  if (error instanceof APIError) {
    // An error Gateway sends inside the stream has no HTTP status; its code carries it ("429").
    const status = error.status ?? (typeof error.code === "string" ? Number(error.code) : undefined);
    if (status === 429) {
      return { cause: "rate_limited", message: "OpenUI Gateway is rate-limiting requests right now. Try again in a minute." };
    }
    if (status === 401 || status === 403) return { cause: "key_refused", message: "OpenUI Gateway refused OpenDashboards' API key." };
    if (status === 402) return { cause: "out_of_credits", message: "OpenUI Gateway says this account is out of credits." };
    if (typeof status === "number" && status >= 500) {
      return { cause: "upstream_error", message: `OpenUI Gateway had an error (HTTP ${status}). Try again.` };
    }
  }
  return { cause: "other", message: "The agent stopped unexpectedly. Try again." };
}

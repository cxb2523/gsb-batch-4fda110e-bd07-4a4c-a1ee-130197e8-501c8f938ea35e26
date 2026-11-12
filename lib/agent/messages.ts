import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";

import { threadIdSchema } from "@/lib/apps/schemas";

/**
 * What the Build chat may send: the thread and its history in Chat
 * Completions shape (Agent Interface's `openAIMessageFormat`). Text only; no
 * system messages; tool results only answering a tool call just before them.
 */

const MAX_MESSAGES = 200;
const MAX_TEXT = 200_000;

const text = z.string().max(MAX_TEXT);
const textParts = z
  .array(z.object({ type: z.literal("text"), text }).strip())
  .max(20);

const userMessage = z
  .object({ role: z.literal("user"), content: z.union([text.min(1), textParts.min(1)]) })
  .strip();

const toolCall = z
  .object({
    id: z.string().min(1).max(200),
    type: z.literal("function"),
    function: z.object({ name: z.string().min(1).max(100), arguments: text }).strip(),
  })
  .strip();

const assistantMessage = z
  .object({
    role: z.literal("assistant"),
    content: z.union([text, textParts]).nullish(),
    tool_calls: z.array(toolCall).max(50).optional(),
  })
  .strip();

const toolMessage = z
  .object({ role: z.literal("tool"), tool_call_id: z.string().min(1).max(200), content: z.union([text, textParts]) })
  .strip();

const message = z.discriminatedUnion("role", [userMessage, assistantMessage, toolMessage]);

/** The AG-UI `context` entry naming the dashboard the user is looking at; its value is the dashboard's id. */
export const VIEWING_DASHBOARD = "The dashboard the user is looking at";

const contextEntry = z.object({ description: z.string().max(200), value: z.string().max(500) }).strip();

export const chatBodySchema = z
  .object({
    threadId: threadIdSchema,
    context: z.array(contextEntry).max(10).optional(),
    messages: z
      .array(message)
      .min(1)
      .max(MAX_MESSAGES)
      .refine((messages) => messages.at(-1)?.role === "user", "The last message must be the user's.")
      .refine(toolResultsAnswerCalls, "Tool results must follow the call they answer."),
  })
  .loose();

export type ChatBody = {
  threadId: string;
  messages: ChatCompletionMessageParam[];
  context?: { description: string; value: string }[];
};

/** Every tool call is answered, in order, before the next non-tool message. */
function toolResultsAnswerCalls(messages: z.infer<typeof message>[]): boolean {
  let open = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool") {
      if (!open.delete(m.tool_call_id)) return false;
      continue;
    }
    if (open.size > 0) return false;
    open = new Set(m.role === "assistant" ? (m.tool_calls ?? []).map((call) => call.id) : []);
  }
  return open.size === 0;
}

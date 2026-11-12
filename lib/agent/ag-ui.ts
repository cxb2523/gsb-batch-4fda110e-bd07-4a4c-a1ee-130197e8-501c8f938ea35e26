import { EventType, type BaseEvent } from "@ag-ui/core";
import type { ChatCompletionChunk, ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * Turns a Chat Completions tool loop into AG-UI events, for the Build chat's
 * `agUIAdapter`. Unlike Chat Completions SSE, AG-UI carries tool results, so
 * the chat can show each tool call running and finishing.
 *
 * Feed it the runner's `chunk` and `message` events as they fire: they arrive
 * in the order things happened, so the events come out in that order too.
 */
export function createAgUiTranslator(emit: (event: BaseEvent) => void) {
  let textId: string | null = null;
  /** Tool calls in the current model round, by their index in the delta. */
  let calls = new Map<number, string>();
  let round: string | undefined;

  function endText() {
    if (!textId) return;
    emit({ type: EventType.TEXT_MESSAGE_END, messageId: textId } as BaseEvent);
    textId = null;
  }

  function endCalls() {
    for (const toolCallId of calls.values()) emit({ type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent);
    calls = new Map();
  }

  return {
    chunk(chunk: ChatCompletionChunk) {
      if (chunk.id !== round) {
        // A new model round. Anything still open from the last one is done.
        endText();
        endCalls();
        round = chunk.id;
      }
      const choice = chunk.choices[0];
      if (!choice) return;
      const { delta } = choice;

      if (delta?.content) {
        if (!textId) {
          textId = crypto.randomUUID();
          emit({ type: EventType.TEXT_MESSAGE_START, messageId: textId, role: "assistant" } as BaseEvent);
        }
        emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: textId, delta: delta.content } as BaseEvent);
      }

      for (const call of delta?.tool_calls ?? []) {
        if (call.id && !calls.has(call.index)) {
          endText();
          calls.set(call.index, call.id);
          emit({
            type: EventType.TOOL_CALL_START,
            toolCallId: call.id,
            toolCallName: call.function?.name ?? "",
          } as BaseEvent);
        }
        const toolCallId = calls.get(call.index);
        if (toolCallId && call.function?.arguments) {
          emit({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: call.function.arguments } as BaseEvent);
        }
      }

      if (choice.finish_reason) {
        endText();
        endCalls();
      }
    },

    /** Tool results, as the loop appends them. */
    message(message: ChatCompletionMessageParam) {
      if (message.role !== "tool") return;
      const content = typeof message.content === "string" ? message.content : message.content.map((p) => p.text).join("");
      const error = toolError(content);
      emit({
        type: EventType.TOOL_CALL_RESULT,
        messageId: crypto.randomUUID(),
        toolCallId: message.tool_call_id,
        content,
        role: "tool",
        ...(error ? { isError: true, error } : {}),
      } as BaseEvent);
    },

    /** Closes anything still open when the loop ends. */
    finish() {
      endText();
      endCalls();
    },
  };
}

/** Agent tools report failures as `{ error: { message } }`. */
function toolError(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { error?: { message?: unknown } };
    const message = parsed?.error?.message;
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

/** One AG-UI event as an SSE frame. */
export function sse(event: BaseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

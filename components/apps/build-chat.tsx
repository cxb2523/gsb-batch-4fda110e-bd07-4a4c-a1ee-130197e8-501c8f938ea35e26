"use client";

import {
  agUIAdapter,
  ChatProvider,
  MarkDownRenderer,
  openAIMessageFormat,
  type MarkDownRendererProps,
  ThemeProvider,
  ToolCallTimeline,
  useOpenuiCloudStorage,
  useThread,
  useThreadList,
  useToolActivities,
  type ChatLLM,
  type Message,
  type TimelineStep,
} from "@openuidev/react-ui";
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, PlusIcon, SparklesIcon, SquareIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseMessage } from "@openuidev/lang-core";
import remarkGfm from "remark-gfm";

import "@openuidev/react-ui/styles/index.css";

import { takePendingPromptAction } from "@/app/(app)/apps/actions";
import { VIEWING_DASHBOARD } from "@/lib/agent/messages";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { dashboardPath, parseAppPath } from "@/lib/apps/paths";
import { usePublishDashboardResponse } from "./app-workspace";
import { scopeStorageToApp } from "@/lib/apps/thread-storage";
import { cn } from "@/lib/utils";

type Dashboard = { id: string; artifactId: string };

/** The dashboard a create/edit response is for, read as Cloud writes it. */
function artifactIdOf(response: string): string | null {
  const id = parseMessage(response).attributes.artifact_id;
  return typeof id === "string" ? id : null;
}

/** GitHub-flavoured Markdown (tables, strikethrough), as react-ui's own text components enable it. */
const markdownOptions: MarkDownRendererProps["options"] = { remarkPlugins: [[remarkGfm, { singleTilde: false }]] };
type AssistantMessage = Extract<Message, { role: "assistant" }>;

/**
 * The Build panel: a slim chat over the app's own threads in OpenUI Cloud.
 *
 * Chat state, streaming and storage are react-headless's (`ChatProvider`,
 * `agUIAdapter`, `useOpenuiCloudStorage`); the "Working / Behind the scenes"
 * timeline and Markdown are react-ui's own components. OpenDashboards only lays them
 * out for a narrow panel, the way Agent Interface lays them out full screen.
 */
export function BuildChat({
  appId,
  dashboards,
  hasPendingPrompt,
}: {
  appId: string;
  dashboards: Dashboard[];
  hasPendingPrompt: boolean;
}) {
  // Taken once: sending the first prompt refreshes the page, which turns
  // hasPendingPrompt off mid-send, and reopening a thread then would abort it.
  const [startedWithPrompt] = useState(hasPendingPrompt);
  const cloud = useOpenuiCloudStorage({ token: "/api/frontend-token" });
  const storage = useMemo(() => scopeStorageToApp(cloud, appId), [cloud, appId]);
  // The dashboard on screen: the one in the URL, or the app's first on its home.
  const pathname = usePathname();
  const { dashboardId } = parseAppPath(pathname);
  const viewingId = (dashboardId ? dashboards.find((d) => d.id === dashboardId) : dashboards[0])?.artifactId ?? null;
  const viewing = useRef<string | null>(viewingId);
  useEffect(() => {
    viewing.current = viewingId;
  }, [viewingId]);

  // fetchLLM's request, plus AG-UI `context` naming the dashboard on screen
  // (fetchLLM always sends an empty context). Same adapter and message format.
  const llm = useMemo<ChatLLM>(
    () => ({
      streamProtocol: agUIAdapter(),
      send: ({ threadId, messages, signal }) =>
        fetch(`/api/apps/${encodeURIComponent(appId)}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId,
            runId: crypto.randomUUID(),
            tools: [],
            context: viewing.current ? [{ description: VIEWING_DASHBOARD, value: viewing.current }] : [],
            messages: openAIMessageFormat.toApi(messages),
          }),
          signal,
        }),
    }),
    [appId],
  );

  return (
    <ThemeProvider mode="light">
      <ChatProvider llm={llm} storage={storage}>
        <div className="dashboards-build-chat flex min-h-0 flex-1 flex-col">
          <ThreadBar />
          <ThreadMessages hasDashboards={dashboards.length > 0} />
          <Composer />
        </div>
        <TurnEffects appId={appId} dashboards={dashboards} hasPendingPrompt={hasPendingPrompt} />
        {/* A new app's first prompt starts its own conversation: nothing to reopen. */}
        {!startedWithPrompt && <ReopenLastThread appId={appId} />}
      </ChatProvider>
    </ThemeProvider>
  );
}

/** The thread in view, the app's other threads, and a new one. */
function ThreadBar() {
  const threads = useThreadList((s) => s.threads);
  const selectedId = useThreadList((s) => s.selectedThreadId);
  const loadThreads = useThreadList((s) => s.loadThreads);
  const selectThread = useThreadList((s) => s.selectThread);
  const newThread = useThreadList((s) => s.switchToNewThread);
  const isRunning = useThread((s) => s.isRunning);

  useEffect(() => loadThreads(), [loadThreads]);

  const current = threads.find((thread) => thread.id === selectedId);

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={isRunning || threads.length === 0}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left text-sm text-muted-foreground hover:bg-neutral-100 hover:text-foreground disabled:pointer-events-none"
        >
          <span className="truncate">{current?.title ?? "New chat"}</span>
          {threads.length > 0 && <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>Chats in this app</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {threads.map((thread) => (
            <DropdownMenuItem key={thread.id} onSelect={() => selectThread(thread.id)}>
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              {thread.id === selectedId && <CheckIcon aria-hidden />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => newThread()}
        disabled={isRunning || !selectedId}
        aria-label="New chat"
      >
        <PlusIcon aria-hidden />
      </Button>
    </div>
  );
}

/** A user message, or a run of assistant and tool messages that make one turn. */
type Group = { kind: "user"; message: Message } | { kind: "turn"; segments: AssistantMessage[] };

/** As Agent Interface groups them: consecutive assistant/tool messages are one turn. */
function groupIntoTurns(messages: Message[]): Group[] {
  const groups: Group[] = [];
  let turn: AssistantMessage[] | null = null;
  for (const message of messages) {
    if (message.role === "assistant" || message.role === "tool") {
      if (!turn) {
        turn = [];
        groups.push({ kind: "turn", segments: turn });
      }
      if (message.role === "assistant") turn.push(message);
    } else {
      turn = null;
      if (message.role === "user") groups.push({ kind: "user", message });
    }
  }
  return groups.filter((group) => group.kind === "user" || group.segments.length > 0);
}

function ThreadMessages({ hasDashboards }: { hasDashboards: boolean }) {
  const messages = useThread((s) => s.messages);
  const isRunning = useThread((s) => s.isRunning);
  const isLoading = useThread((s) => s.isLoadingMessages);
  const threadError = useThread((s) => s.threadError);
  const groups = useMemo(() => groupIntoTurns(messages), [messages]);
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id;
      if (messages[i].role === "user") return null;
    }
    return null;
  }, [messages]);

  // Follow the conversation as it grows, unless the user has scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, isRunning]);

  if (!isLoading && messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <SparklesIcon className="size-5 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">{hasDashboards ? "Change or add dashboards" : "Ask for a dashboard"}</p>
        <p className="text-sm text-muted-foreground">
          Describe what you want to see. OpenDashboards explores your data and builds it.
        </p>
      </div>
    );
  }

  const lastTurnLive = isRunning && groups.at(-1)?.kind === "turn";

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="relative min-h-0 flex-1 overflow-y-auto"
    >
      <div className="flex flex-col gap-4 p-4">
        {groups.map((group) =>
          group.kind === "user" ? (
            <UserBubble key={group.message.id} message={group.message} />
          ) : (
            <AssistantTurn
              key={group.segments[0].id}
              segments={group.segments}
              allMessages={messages}
              live={isRunning && lastAssistantId === group.segments.at(-1)?.id}
            />
          ),
        )}
        {/* Before the first event of a turn arrives, the timeline's own "Working" header. */}
        {isRunning && !lastTurnLive && <ToolCallTimeline activities={[]} isLast awaitingResponse />}
        {!isRunning && threadError && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {threadError.message || "Something went wrong. Try again."}
          </p>
        )}
      </div>
    </div>
  );
}

function UserBubble({ message }: { message: Message }) {
  const text =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => ("text" in part ? part.text : "")).join("")
        : "";
  return (
    <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-neutral-100 px-3.5 py-2.5 text-sm whitespace-pre-wrap">
      {text}
    </div>
  );
}

/**
 * One assistant turn, laid out like Agent Interface's InterleavedTurn: every
 * tool call and the prose between them in one timeline, then the answer.
 *
 * Unlike InterleavedTurn, which streams the answer early only for OpenUI
 * Lang, the Markdown answer streams too: while the turn runs, the latest
 * text shows as the answer as long as no tool call follows it. If one does,
 * that text was a note on the way, and it moves into the timeline.
 */
function AssistantTurn({
  segments,
  allMessages,
  live,
}: {
  segments: AssistantMessage[];
  allMessages: Message[];
  live: boolean;
}) {
  const active = useMemo(() => {
    const withBody = segments.filter((s) => (s.content?.length ?? 0) > 0 || (s.toolCalls?.length ?? 0) > 0);
    return withBody.length > 0 ? withBody : segments;
  }, [segments]);
  const last = active[active.length - 1];
  const merged = useMemo(
    () => ({ ...active[0], toolCalls: active.flatMap((s) => s.toolCalls ?? []) }),
    [active],
  );
  const activities = useToolActivities(merged, allMessages);
  const streaming = (last.content?.length ?? 0) > 0 && (last.toolCalls?.length ?? 0) === 0;
  const answer = !live || streaming ? last : null;
  const answerStarted = !!answer && (answer.content?.length ?? 0) > 0;

  const steps = useMemo(() => {
    const byCallId = new Map(activities.map((activity) => [activity.toolCall.id, activity]));
    const rows: TimelineStep[] = [];
    const claimed = new Set<string>();
    for (const segment of active) {
      if (segment.id !== answer?.id && segment.content) {
        rows.push({ type: "text", id: segment.id, text: segment.content });
      }
      for (const call of segment.toolCalls ?? []) {
        const activity = byCallId.get(call.id);
        if (activity) {
          rows.push({ type: "activity", activity });
          claimed.add(call.id);
        }
      }
    }
    for (const activity of activities) {
      if (!claimed.has(activity.toolCall.id)) rows.push({ type: "activity", activity });
    }
    return rows;
  }, [active, activities, answer?.id]);

  return (
    <div className="flex flex-col gap-3">
      {(activities.length > 0 || (live && !answerStarted)) && (
        <ToolCallTimeline
          activities={activities}
          steps={steps}
          isLast={live}
          forceDefault
          awaitingResponse={live && !answerStarted}
        />
      )}
      {answer?.content && <MarkDownRenderer textMarkdown={answer.content} options={markdownOptions} className="text-sm" />}
    </div>
  );
}

function Composer() {
  const [text, setText] = useState("");
  const isRunning = useThread((s) => s.isRunning);
  const processMessage = useThread((s) => s.processMessage);
  const cancel = useThread((s) => s.cancelMessage);
  const canSend = text.trim().length > 0 && !isRunning;

  function send() {
    if (!canSend) return;
    void processMessage({ role: "user", content: text.trim() });
    setText("");
  }

  return (
    <div className="shrink-0 border-t p-3">
      <div className="flex items-end gap-2 rounded-xl border bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-ring/30">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder="Ask OpenDashboards to build or change a dashboard…"
          aria-label="Message OpenDashboards"
          className="max-h-40 min-h-7 flex-1 resize-none bg-transparent py-1 text-sm outline-none [field-sizing:content] placeholder:text-muted-foreground"
        />
        {isRunning ? (
          <Button size="icon-sm" variant="secondary" onClick={() => cancel()} aria-label="Stop">
            <SquareIcon className="fill-current" aria-hidden />
          </Button>
        ) : (
          <Button
            size="icon-sm"
            onClick={send}
            disabled={!canSend}
            aria-label="Send"
            className={cn("rounded-full", !canSend && "opacity-40")}
          >
            <ArrowUpIcon aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}

const lastThreadKey = (appId: string) => `opendashboards:build:last-thread:${appId}`;

/**
 * Opening Build on an app reopens the conversation last open there (in this
 * browser), or else the most recent one. Remembering it is a convenience,
 * so storage that's blocked or empty just falls back.
 */
function ReopenLastThread({ appId }: { appId: string }) {
  const threads = useThreadList((s) => s.threads);
  const selectedId = useThreadList((s) => s.selectedThreadId);
  const selectThread = useThreadList((s) => s.selectThread);
  const reopened = useRef(false);

  useEffect(() => {
    if (reopened.current || !threads.length) return;
    reopened.current = true;
    if (selectedId) return; // Already chose one (or sent a message) before the list arrived.
    let last: string | null = null;
    try {
      last = localStorage.getItem(lastThreadKey(appId));
    } catch {}
    const thread = threads.find((candidate) => candidate.id === last) ?? threads[0];
    selectThread(thread.id);
  }, [appId, threads, selectedId, selectThread]);

  useEffect(() => {
    if (!selectedId) return;
    try {
      localStorage.setItem(lastThreadKey(appId), selectedId);
    } catch {}
  }, [appId, selectedId]);

  return null;
}

/**
 * Sends the app's first prompt once, and when a turn ends refreshes the app
 * and opens the dashboard the turn created.
 */
function TurnEffects({
  appId,
  dashboards,
  hasPendingPrompt,
}: {
  appId: string;
  dashboards: Dashboard[];
  hasPendingPrompt: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const processMessage = useThread((s) => s.processMessage);
  const isRunning = useThread((s) => s.isRunning);

  // The prompt the app was created with goes first, once.
  const sentPending = useRef(false);
  useEffect(() => {
    if (!hasPendingPrompt || sentPending.current) return;
    sentPending.current = true;
    void takePendingPromptAction(appId).then((prompt) => {
      if (prompt) void processMessage({ role: "user", content: prompt });
      router.refresh();
    });
  }, [appId, hasPendingPrompt, processMessage, router]);

  // Cloud's create/edit responses go to the dashboard they're for as they
  // arrive, so an open dashboard follows the edit; a new one opens to be watched.
  const messages = useThread((s) => s.messages);
  const publish = usePublishDashboardResponse();
  const handled = useRef(new Set<string>());
  const opening = useRef<string | null>(null);
  useEffect(() => {
    // Only results arriving in this run: a thread loaded from history doesn't replay.
    if (!isRunning) return;
    const toolNames = new Map<string, string>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.function.name);
    }
    for (const message of messages) {
      if (message.role !== "tool" || handled.current.has(message.id)) continue;
      handled.current.add(message.id);
      const tool = toolNames.get(message.toolCallId);
      if (tool !== "create_dashboard" && tool !== "edit_dashboard") continue;
      const artifactId = artifactIdOf(message.content);
      if (!artifactId) continue;
      publish(artifactId, message.content);
      if (tool === "create_dashboard") {
        opening.current = artifactId;
        router.refresh(); // The server has recorded it; the sidebar picks it up.
      }
    }
  }, [isRunning, messages, publish, router]);

  useEffect(() => {
    if (!opening.current) return;
    const created = dashboards.find((dashboard) => dashboard.artifactId === opening.current);
    if (!created) return;
    opening.current = null;
    if (parseAppPath(pathname).dashboardId !== created.id) router.push(dashboardPath(appId, created.id));
  }, [appId, dashboards, pathname, router]);

  // When a turn ends, pick up titles and deletions.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !isRunning) router.refresh();
    wasRunning.current = isRunning;
  }, [isRunning, router]);

  return null;
}

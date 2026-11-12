"use client";

import { ArrowRightIcon, CheckIcon, Loader2Icon, PlusIcon, SparklesIcon } from "lucide-react";
import { useState, useTransition } from "react";

import { createAppAction } from "@/app/(app)/apps/actions";
import { installDemoAction } from "@/app/(app)/connections/actions";
import { PromptBox } from "@/components/apps/prompt-box";
import { PostHogFormDialog, type SecretMode } from "@/components/connections/connection-form-dialog";
import { PostgresFormDialog } from "@/components/connections/postgres-form-dialog";
import { SourceFormDialog } from "@/components/connections/source-form-dialog";
import { SourceTile } from "@/components/connections/source-tile";
import { Button } from "@/components/ui/button";
import type { SourceOption } from "@/lib/sources/catalog";
import { cn } from "@/lib/utils";

import { DISCOVERY_PROMPT } from "./discovery-prompt";

export type OnboardingConnection = {
  id: string;
  name: string;
  /** "PostHog US", "Postgres". */
  source: string;
  tile: string;
  /** Set when it's an installed demo dataset. */
  demo: string | null;
};

export type OnboardingSource = SourceOption;

export type OnboardingDemo = {
  key: string;
  name: string;
  description: string;
  prompts: string[];
  connectionId: string | null;
};

type Step = "data" | "build";

/**
 * What a user with no apps sees in place of the home page: pick or connect
 * data, then build a first app, by letting OpenDashboards explore the data and
 * suggest dashboards or by describing one. Creating the app ends it.
 */
export function Onboarding({
  connections,
  sources,
  demos,
  secretMode,
}: {
  connections: OnboardingConnection[];
  sources: OnboardingSource[];
  demos: OnboardingDemo[];
  secretMode: SecretMode;
}) {
  const [step, setStep] = useState<Step>("data");
  // Their own data, ticked at first; installed demos only when that's all they have.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const own = connections.filter((connection) => !connection.demo);
    return new Set((own.length ? own : connections).map((connection) => connection.id));
  });

  function pickOnly(id: string) {
    setSelected(new Set([id]));
    setStep("build");
  }

  return (
    <div className="relative mx-auto w-full max-w-2xl px-6 pt-16 pb-16 sm:pt-24">
      <Steps step={step} />
      {step === "data" ? (
        <DataStep
          connections={connections}
          sources={sources}
          demos={demos}
          secretMode={secretMode}
          selected={selected}
          onToggle={(id) =>
            setSelected((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onContinue={() => setStep("build")}
          onPickOnly={pickOnly}
        />
      ) : (
        <BuildStep
          connections={connections.filter((connection) => selected.has(connection.id))}
          allConnections={connections}
          demos={demos}
          onBack={() => setStep("data")}
        />
      )}
    </div>
  );
}

function Steps({ step }: { step: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "data", label: "Connect data" },
    { key: "build", label: "Build" },
  ];
  const current = steps.findIndex((candidate) => candidate.key === step);
  return (
    <ol className="mb-8 flex items-center justify-center gap-3 text-xs" aria-label="Getting started">
      {steps.map((candidate, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={candidate.key} className="flex items-center gap-3">
            {index > 0 && <span aria-hidden className="h-px w-8 bg-border" />}
            <span
              className={cn("flex items-center gap-2", active ? "font-medium text-foreground" : "text-muted-foreground")}
              aria-current={active ? "step" : undefined}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border text-[0.6875rem]",
                  active && "border-foreground bg-foreground text-background",
                  done && "border-foreground/30 text-foreground",
                )}
              >
                {done ? <CheckIcon className="size-3" /> : index + 1}
              </span>
              {candidate.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Heading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-10 text-center">
      <h1 className="text-3xl font-bold tracking-tight sm:text-[2.25rem] sm:leading-tight">{title}</h1>
      <p className="mx-auto mt-3 max-w-md text-[0.9375rem] text-muted-foreground">{description}</p>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2.5 text-sm font-medium">{children}</h2>;
}

const card =
  "rounded-xl border bg-background transition-colors hover:border-neutral-300 hover:bg-neutral-50/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";

function DataStep({
  connections,
  sources,
  demos,
  secretMode,
  selected,
  onToggle,
  onContinue,
  onPickOnly,
}: {
  connections: OnboardingConnection[];
  sources: OnboardingSource[];
  demos: OnboardingDemo[];
  secretMode: SecretMode;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onContinue: () => void;
  onPickOnly: (id: string) => void;
}) {
  const [adding, setAdding] = useState<OnboardingSource | null>(null);
  // Kept after closing, so the dialog doesn't remount mid-animation.
  const [postgresFlavor, setPostgresFlavor] = useState<OnboardingSource["flavor"]>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hasData = connections.length > 0;
  // Installed ones are already listed under "Your data".
  const available = demos.filter((demo) => !demo.connectionId);

  function pickDemo(dataset: string) {
    setError(null);
    setInstalling(dataset);
    startTransition(async () => {
      const result = await installDemoAction({ dataset });
      setInstalling(null);
      if (result.ok) onPickOnly(result.data.id);
      else setError(result.error.message);
    });
  }

  const dialog = {
    mode: "create" as const,
    secretMode,
    onOpenChange: (open: boolean) => !open && setAdding(null),
    onCreated: onPickOnly,
  };

  return (
    <>
      <Heading
        title={hasData ? "Pick your data" : "Where's your data?"}
        description="OpenDashboards runs read-only queries against your data to build live dashboards from it."
      />

      {hasData && (
        <section className="mb-10">
          <Label>Your data</Label>
          <ul className="divide-y rounded-xl border">
            {connections.map((connection) => {
              const checked = selected.has(connection.id);
              return (
                <li key={connection.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => onToggle(connection.id)}
                    className="flex w-full items-center gap-3 p-3 text-left transition-colors outline-none first:rounded-t-xl last:rounded-b-xl hover:bg-neutral-50/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
                  >
                    <SourceTile label={connection.tile} className="size-9" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{connection.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {connection.demo ? "Sample data" : connection.source}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-4.5 shrink-0 items-center justify-center rounded-[5px] border",
                        checked && "border-foreground bg-foreground text-background",
                      )}
                    >
                      {checked && <CheckIcon className="size-3" />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex justify-end">
            <Button onClick={onContinue} disabled={selected.size === 0}>
              Continue
              <ArrowRightIcon aria-hidden />
            </Button>
          </div>
        </section>
      )}

      <section>
        <Label>{hasData ? "Or connect another source" : "Connect a source"}</Label>
        <ul className="grid gap-3 sm:grid-cols-2">
          {sources.map((source) => (
            <li key={source.key}>
              <button
                type="button"
                onClick={() => {
                  setAdding(source);
                  if (source.type === "postgres") setPostgresFlavor(source.flavor);
                }}
                className={cn(card, "flex h-full w-full items-start gap-3 p-3.5 text-left")}
              >
                <SourceTile label={source.tile} className="size-9" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{source.label}</span>
                  <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{source.blurb}</span>
                </span>
                <PlusIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </section>

      {available.length > 0 && (
        <section className="mt-10">
          <div className="mb-4 flex items-center gap-3 text-xs text-muted-foreground">
            <span aria-hidden className="h-px flex-1 bg-border" />
            No data handy?
            <span aria-hidden className="h-px flex-1 bg-border" />
          </div>
          <Label>Try it with sample data</Label>
          <ul className="flex flex-col gap-3">
            {available.map((demo) => (
              <li key={demo.key}>
                <button
                  type="button"
                  onClick={() => pickDemo(demo.key)}
                  disabled={pending}
                  className={cn(card, "flex w-full items-center gap-3 p-3.5 text-left")}
                >
                  <SourceTile label="DM" className="size-9" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{demo.name}</span>
                    <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {demo.description}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-xs font-medium">
                    {installing === demo.key ? (
                      <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
                    ) : (
                      <>
                        Use this
                        <ArrowRightIcon className="size-3.5" aria-hidden />
                      </>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p role="alert" className="mt-4 text-center text-sm text-destructive">
          {error}
        </p>
      )}

      <PostHogFormDialog {...dialog} open={adding?.type === "posthog"} />
      <SourceFormDialog {...dialog} type="mysql" open={adding?.type === "mysql"} />
      <SourceFormDialog {...dialog} type="clickhouse" open={adding?.type === "clickhouse"} />
      <SourceFormDialog {...dialog} type="bigquery" open={adding?.type === "bigquery"} />
      <SourceFormDialog {...dialog} type="ga4" open={adding?.type === "ga4"} />
      <SourceFormDialog {...dialog} type="searchconsole" open={adding?.type === "searchconsole"} />
      <SourceFormDialog {...dialog} type="mcp" open={adding?.type === "mcp"} />
      {/* Keyed by flavor so each opens with its own defaults. */}
      <PostgresFormDialog
        key={postgresFlavor ?? "postgres"}
        {...dialog}
        flavor={postgresFlavor}
        open={adding?.type === "postgres"}
      />
    </>
  );
}

function BuildStep({
  connections,
  allConnections,
  demos,
  onBack,
}: {
  connections: OnboardingConnection[];
  allConnections: OnboardingConnection[];
  demos: OnboardingDemo[];
  onBack: () => void;
}) {
  const [writing, setWriting] = useState(false);
  const [started, setStarted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = connections.map((connection) => connection.id);
  // Example prompts of the sample datasets in use.
  const examples = demos.filter((demo) => connections.some((connection) => connection.demo === demo.key));

  function build(prompt: string) {
    setError(null);
    setStarted(prompt);
    startTransition(async () => {
      // Only returns when creating failed; on success it opens the new app.
      const result = await createAppAction({ prompt, connectionIds: ids });
      if (result && !result.ok) {
        setError(result.error.message);
        setStarted(null);
      }
    });
  }

  return (
    <>
      <Heading
        title="What should OpenDashboards build?"
        description="OpenDashboards can look through your data and suggest dashboards, or you can describe one yourself."
      />

      <div className="mb-6 flex flex-wrap items-center justify-center gap-1.5 text-xs">
        <span className="text-muted-foreground">Using</span>
        {connections.map((connection) => (
          <span key={connection.id} className="rounded-md bg-neutral-100 px-1.5 py-0.5 text-neutral-700">
            {connection.name}
          </span>
        ))}
        <button
          type="button"
          onClick={onBack}
          disabled={pending}
          className="ml-1 font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-60"
        >
          Change
        </button>
      </div>

      <button
        type="button"
        onClick={() => build(DISCOVERY_PROMPT)}
        disabled={pending}
        className={cn(
          card,
          "flex w-full items-center gap-4 p-5 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)]",
        )}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
          {started === DISCOVERY_PROMPT ? (
            <Loader2Icon className="size-4.5 animate-spin" aria-hidden />
          ) : (
            <SparklesIcon className="size-4.5" aria-hidden />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[0.9375rem] font-medium">Explore my data and suggest dashboards</span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            OpenDashboards looks at what&apos;s in your data and proposes a few dashboards for you to pick from.
          </span>
        </span>
        <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {examples.length > 0 && (
        <section className="mt-8">
          <Label>Or start from an example</Label>
          <ul className="flex flex-col gap-2">
            {examples.flatMap((demo) =>
              demo.prompts.map((prompt) => (
                <li key={`${demo.key}:${prompt}`}>
                  <button
                    type="button"
                    onClick={() => build(prompt)}
                    disabled={pending}
                    className={cn(card, "flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm")}
                  >
                    <span className="min-w-0 flex-1">{prompt}</span>
                    {started === prompt && (
                      <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                    )}
                  </button>
                </li>
              )),
            )}
          </ul>
        </section>
      )}

      <section className="mt-8">
        {writing ? (
          <>
            <Label>Describe a dashboard</Label>
            <PromptBox
              connections={allConnections.map(({ id, name, source }) => ({ id, name, source }))}
              initiallySelected={ids}
              autoFocus
            />
          </>
        ) : (
          <div className="text-center">
            <button
              type="button"
              onClick={() => setWriting(true)}
              disabled={pending}
              className="text-sm font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
            >
              I know what I want to build
            </button>
          </div>
        )}
      </section>

      {error && (
        <p role="alert" className="mt-4 text-center text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

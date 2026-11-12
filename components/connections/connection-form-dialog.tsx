"use client";

import { ExternalLinkIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { createConnectionAction, replaceCredentialAction } from "@/app/(app)/connections/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ConnectionField } from "@/lib/connections/errors";
import { HOST_KINDS, POSTHOG_HOSTS, type HostKind } from "@/lib/sources/posthog/hosts";
import type { SecretProvider } from "@/lib/secrets/types";

export type SecretMode = SecretProvider | "unconfigured";

type ExistingConnection = { id: string; name: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secretMode: SecretMode;
} & (
  | { mode: "create"; /** Called with the new connection's id once it's saved. */ onCreated?: (id: string) => void }
  | { mode: "replace"; connection: ExistingConnection }
);

type Values = { name: string; hostKind: HostKind; projectId: string; apiKey: string };

const EMPTY: Values = { name: "", hostKind: "posthog_us", projectId: "", apiKey: "" };

/** Adds a PostHog connection, or replaces an existing PostHog connection's key. */
export function PostHogFormDialog(props: Props) {
  const { open, onOpenChange, secretMode } = props;
  const replacing = props.mode === "replace";
  const initial: Values = EMPTY;

  const [values, setValues] = useState<Values>(initial);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ConnectionField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = { name: useId(), projectId: useId(), apiKey: useId(), region: useId() };

  const host = POSTHOG_HOSTS[values.hostKind];
  const storageMissing = secretMode === "unconfigured";

  function reset() {
    setValues(initial);
    setFieldErrors({});
    setFormError(null);
  }

  function update<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
    setFormError(null);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = replacing
        ? await replaceCredentialAction({ id: props.connection.id, credential: values.apiKey })
        : await createConnectionAction({ type: "posthog", ...values });

      if (result.ok) {
        toast.success(replacing ? "Key replaced" : `Connected to ${values.name.trim()}`);
        onOpenChange(false);
        reset();
        if (props.mode === "create" && result.data && "id" in result.data && typeof result.data.id === "string") {
          props.onCreated?.(result.data.id);
        }
        return;
      }
      if (result.error.field) {
        setFieldErrors({ [result.error.field]: result.error.message });
      } else {
        setFormError(result.error.message);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{replacing ? "Replace key" : "Connect PostHog"}</DialogTitle>
            <DialogDescription>
              {replacing
                ? `Enter a new personal API key for ${props.connection.name}. The region and project stay the same.`
                : "OpenDashboards runs read-only queries against your PostHog project to build dashboards."}
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="my-6 gap-5">
            {!replacing && (
              <Field data-invalid={!!fieldErrors.name || undefined}>
                <FieldLabel htmlFor={ids.name}>Name</FieldLabel>
                <Input
                  id={ids.name}
                  value={values.name}
                  onChange={(e) => update("name", e.target.value)}
                  placeholder="Production analytics"
                  maxLength={80}
                  autoComplete="off"
                  aria-invalid={!!fieldErrors.name || undefined}
                  required
                  autoFocus
                />
                <FieldError>{fieldErrors.name}</FieldError>
              </Field>
            )}

            {!replacing && (
              <>
              <Field data-invalid={!!fieldErrors.hostKind || undefined}>
                <FieldLabel id={ids.region}>Region</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  aria-labelledby={ids.region}
                  value={values.hostKind}
                  onValueChange={(value) => value && update("hostKind", value as HostKind)}
                  className="w-full"
                >
                  {HOST_KINDS.map((kind) => (
                    <ToggleGroupItem key={kind} value={kind} className="flex-1">
                      {POSTHOG_HOSTS[kind].label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <FieldError>{fieldErrors.hostKind}</FieldError>
              </Field>

              <Field data-invalid={!!fieldErrors.projectId || undefined}>
                <FieldLabel htmlFor={ids.projectId}>Project ID</FieldLabel>
                <Input
                  id={ids.projectId}
                  value={values.projectId}
                  onChange={(e) => update("projectId", e.target.value)}
                  placeholder="12345"
                  inputMode="numeric"
                  autoComplete="off"
                  aria-invalid={!!fieldErrors.projectId || undefined}
                  required
                />
                <FieldDescription>
                  Find it in PostHog&apos;s{" "}
                  <ExternalLink href={`${host.url}/settings/project`}>project settings</ExternalLink>.
                </FieldDescription>
                <FieldError>{fieldErrors.projectId}</FieldError>
              </Field>
              </>
            )}

            <Field data-invalid={!!fieldErrors.apiKey || undefined}>
              <FieldLabel htmlFor={ids.apiKey}>Personal API key</FieldLabel>
              <Input
                id={ids.apiKey}
                type="password"
                value={values.apiKey}
                onChange={(e) => update("apiKey", e.target.value)}
                placeholder="phx_…"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!fieldErrors.apiKey || undefined}
                required
                autoFocus={replacing}
              />
              <FieldDescription>
                {replacing ? "Create a key" : <ExternalLink href={`${host.url}/settings/user-api-keys`}>Create a key</ExternalLink>}{" "}
                with only the <strong className="font-medium text-foreground">Query Read</strong>{" "}
                scope, limited to this project.
              </FieldDescription>
              <FieldError>{fieldErrors.apiKey}</FieldError>
            </Field>

            {secretMode === "plaintext" && (
              <p className="flex gap-2 text-xs text-muted-foreground">
                <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
                Local development: keys are stored unencrypted. Use a key for a test project.
              </p>
            )}
            {storageMissing && (
              <p role="alert" className="flex gap-2 text-sm text-destructive">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                Secret storage isn&apos;t set up on this server, so keys can&apos;t be saved yet.
              </p>
            )}
            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}
          </FieldGroup>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || storageMissing}>
              {pending && <Loader2Icon className="animate-spin" aria-hidden />}
              {pending ? "Testing…" : replacing ? "Test & replace" : "Test & save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline"
    >
      {children}
      <ExternalLinkIcon className="size-3" aria-hidden />
    </a>
  );
}

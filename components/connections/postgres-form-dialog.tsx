"use client";

import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
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
import {
  DEFAULT_PORT,
  parseConnectionString,
  POSTGRES_FLAVORS,
  SSL_MODES,
  type PostgresFlavor,
  type SslMode,
} from "@/lib/sources/postgres/catalog";

import { showConnectionWarnings } from "./connection-feedback";
import type { SecretMode } from "./connection-form-dialog";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secretMode: SecretMode;
} & (
  | {
      mode: "create";
      /** A hosted service that's Postgres underneath: tailors the title, hints and SSL default. */
      flavor?: PostgresFlavor | null;
      /** Called with the new connection's id once it's saved. */
      onCreated?: (id: string) => void;
    }
  | { mode: "replace"; connection: { id: string; name: string } }
);

type Values = {
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  sslMode: SslMode;
};

const EMPTY: Values = {
  name: "",
  host: "",
  port: String(DEFAULT_PORT),
  database: "",
  user: "",
  password: "",
  sslMode: "verify-full",
};

const SSL_LABELS: Record<SslMode, string> = {
  "verify-full": "Verify certificate",
  require: "Encrypt only",
};

const READ_ONLY_ROLE_SQL = `CREATE ROLE dashboards_reader LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE your_db TO dashboards_reader;
GRANT USAGE ON SCHEMA public TO dashboards_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dashboards_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO dashboards_reader;`;

/** Adds a Postgres connection, or changes an existing one's password. */
export function PostgresFormDialog(props: Props) {
  const { open, onOpenChange, secretMode } = props;
  const replacing = props.mode === "replace";
  const flavor = props.mode === "create" && props.flavor ? POSTGRES_FLAVORS[props.flavor] : null;
  const initial: Values = flavor ? { ...EMPTY, sslMode: flavor.sslMode } : EMPTY;

  const [values, setValues] = useState<Values>(initial);
  const [connectionString, setConnectionString] = useState("");
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ConnectionField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = {
    name: useId(),
    url: useId(),
    host: useId(),
    port: useId(),
    database: useId(),
    user: useId(),
    password: useId(),
    ssl: useId(),
  };

  const storageMissing = secretMode === "unconfigured";

  function reset() {
    setValues(initial);
    setConnectionString("");
    setPasteNote(null);
    setFieldErrors({});
    setFormError(null);
  }

  function update<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
    setFormError(null);
  }

  /** Fills the fields from a pasted postgres:// URL. The URL itself is never sent. */
  function applyConnectionString(text: string) {
    setConnectionString(text);
    if (!text.trim()) return setPasteNote(null);
    const parsed = parseConnectionString(text);
    if (!parsed) return setPasteNote("That isn't a postgres:// connection string.");
    setValues((current) => ({
      ...current,
      ...(parsed.host !== undefined && { host: parsed.host }),
      ...(parsed.port !== undefined && { port: String(parsed.port) }),
      ...(parsed.database !== undefined && { database: parsed.database }),
      ...(parsed.user !== undefined && { user: parsed.user }),
      ...(parsed.password !== undefined && { password: parsed.password }),
      ...(parsed.sslMode !== undefined && { sslMode: parsed.sslMode }),
    }));
    setFieldErrors({});
    setPasteNote("Filled in the fields below. Check them, then test.");
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const { name, host, port, database, user, password, sslMode } = values;
      const result = replacing
        ? await replaceCredentialAction({ id: props.connection.id, credential: password })
        : await createConnectionAction({ type: "postgres", name, host, port, database, user, password, sslMode });

      if (result.ok) {
        toast.success(replacing ? "Password changed" : `Connected to ${name.trim()}`);
        showConnectionWarnings(result.data?.warnings);
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

  const textField = (
    key: "name" | "host" | "database" | "user",
    label: string,
    placeholder: string,
    extra: Partial<React.ComponentProps<typeof Input>> = {},
  ) => (
    <Field data-invalid={!!fieldErrors[key] || undefined}>
      <FieldLabel htmlFor={ids[key]}>{label}</FieldLabel>
      <Input
        id={ids[key]}
        value={values[key]}
        onChange={(e) => update(key, e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!fieldErrors[key] || undefined}
        required
        {...extra}
      />
      <FieldError>{fieldErrors[key]}</FieldError>
    </Field>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{replacing ? "Change password" : `Connect ${flavor?.label ?? "Postgres"}`}</DialogTitle>
            <DialogDescription>
              {replacing
                ? `Enter the new password for ${props.connection.name}. The host, database and user stay the same.`
                : "OpenDashboards runs read-only queries against your database to build dashboards."}
            </DialogDescription>
            {flavor && <p className="text-sm text-muted-foreground">{flavor.tip}</p>}
          </DialogHeader>

          <FieldGroup className="my-6 gap-5">
            {!replacing && (
              <>
                {textField("name", "Name", flavor ? `${flavor.label} database` : "Production database", {
                  maxLength: 80,
                  autoFocus: true,
                  spellCheck: undefined,
                })}

                <Field>
                  <FieldLabel htmlFor={ids.url}>Connection string (optional)</FieldLabel>
                  <Input
                    id={ids.url}
                    value={connectionString}
                    onChange={(e) => applyConnectionString(e.target.value)}
                    placeholder="postgres://user:password@host:5432/database"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <FieldDescription>{pasteNote ?? "Paste one to fill in the fields. It isn't saved."}</FieldDescription>
                </Field>

                <div className="grid grid-cols-[1fr_6rem] gap-3">
                  {textField("host", "Host", flavor?.hostPlaceholder ?? "db.example.com")}
                  <Field data-invalid={!!fieldErrors.port || undefined}>
                    <FieldLabel htmlFor={ids.port}>Port</FieldLabel>
                    <Input
                      id={ids.port}
                      value={values.port}
                      onChange={(e) => update("port", e.target.value)}
                      inputMode="numeric"
                      autoComplete="off"
                      aria-invalid={!!fieldErrors.port || undefined}
                      required
                    />
                    <FieldError>{fieldErrors.port}</FieldError>
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {textField("database", "Database", flavor?.databasePlaceholder ?? "app")}
                  {textField("user", "User", flavor?.userPlaceholder ?? "dashboards_reader")}
                </div>
              </>
            )}

            <Field data-invalid={!!fieldErrors.password || undefined}>
              <FieldLabel htmlFor={ids.password}>Password</FieldLabel>
              <Input
                id={ids.password}
                type="password"
                value={values.password}
                onChange={(e) => update("password", e.target.value)}
                autoComplete="off"
                aria-invalid={!!fieldErrors.password || undefined}
                autoFocus={replacing}
              />
              <FieldDescription>Leave empty for a server that doesn&apos;t need one.</FieldDescription>
              <FieldError>{fieldErrors.password}</FieldError>
            </Field>

            {!replacing && (
              <Field data-invalid={!!fieldErrors.sslMode || undefined}>
                <FieldLabel id={ids.ssl}>SSL</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  aria-labelledby={ids.ssl}
                  value={values.sslMode}
                  onValueChange={(value) => value && update("sslMode", value as SslMode)}
                  className="w-full"
                >
                  {SSL_MODES.map((mode) => (
                    <ToggleGroupItem key={mode} value={mode} className="flex-1">
                      {SSL_LABELS[mode]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <FieldDescription>
                  {values.sslMode === "verify-full"
                    ? "Encrypted, and the server's certificate is checked. Recommended."
                    : "Encrypted, but the certificate isn't checked. Use for self-signed certificates."}
                </FieldDescription>
                <FieldError>{fieldErrors.sslMode}</FieldError>
              </Field>
            )}

            {!replacing && (
              <details className="group rounded-lg border px-3 py-2 text-sm">
                <summary className="cursor-pointer text-muted-foreground select-none group-open:mb-2">
                  Use a read-only user (recommended)
                </summary>
                <p className="mb-2 text-xs text-muted-foreground">
                  OpenDashboards only reads, but a user that can&apos;t write is safer. Run this as an admin, then connect
                  as <code>dashboards_reader</code>:
                </p>
                <pre className="overflow-x-auto rounded-md bg-neutral-50 p-2.5 text-[0.6875rem] leading-relaxed">
                  {READ_ONLY_ROLE_SQL}
                </pre>
              </details>
            )}

            {secretMode === "plaintext" && (
              <p className="flex gap-2 text-xs text-muted-foreground">
                <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
                Local development: passwords are stored unencrypted. Use a test database.
              </p>
            )}
            {storageMissing && (
              <p role="alert" className="flex gap-2 text-sm text-destructive">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                Secret storage isn&apos;t set up on this server, so passwords can&apos;t be saved yet.
              </p>
            )}
            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || storageMissing}>
              {pending && <Loader2Icon className="animate-spin" aria-hidden />}
              {pending ? "Testing…" : "Test & save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

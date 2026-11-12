"use client";

import { Loader2Icon, TriangleAlertIcon, UploadIcon } from "lucide-react";
import { useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { createConnectionAction, replaceCredentialAction } from "@/app/(app)/connections/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SSL_MODES, type SslMode } from "@/lib/sources/host";

import { showConnectionWarnings } from "./connection-feedback";
import type { SecretMode } from "./connection-form-dialog";
import { SOURCE_FORMS, type FieldSpec } from "./source-forms";

export type FormSourceType = keyof typeof SOURCE_FORMS;

type Props = {
  type: FormSourceType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secretMode: SecretMode;
} & (
  | { mode: "create"; /** Called with the new connection's id once it's saved. */ onCreated?: (id: string) => void }
  | { mode: "replace"; connection: { id: string; name: string } }
);

const SSL_LABELS: Record<SslMode, string> = { "verify-full": "Verify certificate", require: "Encrypt only" };

/** Adds a MySQL, ClickHouse or BigQuery connection, or replaces its password or key. */
export function SourceFormDialog(props: Props) {
  const { type, open, onOpenChange, secretMode } = props;
  const spec = SOURCE_FORMS[type];
  const replacing = props.mode === "replace";
  const fields = replacing ? [spec.credential] : [...spec.fields, spec.credential];

  const initial = (): Record<string, string> => Object.fromEntries(fields.map((field) => [field.name, field.initial ?? ""]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [pasted, setPasted] = useState("");
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const baseId = useId();
  const id = (name: string) => `${baseId}-${name}`;
  const storageMissing = secretMode === "unconfigured";

  function reset() {
    setValues(initial());
    setPasted("");
    setPasteNote(null);
    setFieldErrors({});
    setFormError(null);
  }

  function update(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value, ...spec.derive?.(name, value, current) }));
    setFieldErrors((current) => ({ ...current, [name]: undefined }));
    setFormError(null);
  }

  function applyPaste(text: string) {
    setPasted(text);
    if (!spec.paste || !text.trim()) return setPasteNote(null);
    const parsed = spec.paste.parse(text);
    if (!parsed) return setPasteNote("That isn't a connection string OpenDashboards recognizes.");
    setValues((current) => ({ ...current, ...Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)])) }));
    setFieldErrors({});
    setPasteNote("Filled in the fields below. Check them, then test.");
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result =
        props.mode === "replace"
          ? await replaceCredentialAction({ id: props.connection.id, credential: values[spec.credential.name] ?? "" })
          : await createConnectionAction({ type, ...values });

      if (result.ok) {
        toast.success(replacing ? "Saved" : `Connected to ${(values.name ?? "").trim()}`);
        const data = result.data as { id?: unknown; warnings?: Parameters<typeof showConnectionWarnings>[0] } | undefined;
        showConnectionWarnings(data?.warnings);
        onOpenChange(false);
        reset();
        if (props.mode === "create" && typeof data?.id === "string") props.onCreated?.(data.id);
        return;
      }
      if (result.error.field && fields.some((field) => field.name === result.error.field)) {
        setFieldErrors({ [result.error.field]: result.error.message });
      } else {
        setFormError(result.error.message);
      }
    });
  }

  const renderField = (field: FieldSpec) => {
    const error = fieldErrors[field.name];
    if (field.kind === "ssl") {
      return (
        <Field key={field.name} data-invalid={!!error || undefined}>
          <FieldLabel id={id(field.name)}>{field.label}</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            aria-labelledby={id(field.name)}
            value={values[field.name]}
            onValueChange={(value) => value && update(field.name, value)}
            className="w-full"
          >
            {SSL_MODES.map((mode) => (
              <ToggleGroupItem key={mode} value={mode} className="flex-1">
                {SSL_LABELS[mode]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>
            {values[field.name] === "verify-full"
              ? "Encrypted, and the server's certificate is checked. Recommended."
              : "Encrypted, but the certificate isn't checked. Use for self-signed certificates."}
          </FieldDescription>
          <FieldError>{error}</FieldError>
        </Field>
      );
    }
    return (
      <Field key={field.name} data-invalid={!!error || undefined}>
        <FieldLabel htmlFor={id(field.name)}>{field.label}</FieldLabel>
        {field.kind === "textarea" ? (
          <TextareaWithFile field={field} id={id(field.name)} value={values[field.name] ?? ""} invalid={!!error} onChange={(value) => update(field.name, value)} />
        ) : (
          <Input
            id={id(field.name)}
            type={field.kind === "password" ? "password" : "text"}
            inputMode={field.kind === "number" ? "numeric" : undefined}
            value={values[field.name] ?? ""}
            onChange={(e) => update(field.name, e.target.value)}
            placeholder={field.placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!error || undefined}
            required={!field.optional}
            autoFocus={replacing ? field === spec.credential : field === fields[0]}
          />
        )}
        {field.description && <FieldDescription>{field.description}</FieldDescription>}
        <FieldError>{error}</FieldError>
      </Field>
    );
  };

  // Half-width fields sit side by side, in pairs.
  const rows: FieldSpec[][] = [];
  for (const field of fields) {
    const last = rows.at(-1);
    if (field.half && last?.length === 1 && last[0].half) last.push(field);
    else rows.push([field]);
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{props.mode === "replace" ? spec.replaceTitle : spec.title}</DialogTitle>
            <DialogDescription>
              {props.mode === "replace" ? `For ${props.connection.name}. Everything else stays the same.` : spec.description}
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="my-6 gap-5">
            {!replacing && spec.paste && (
              <Field>
                <FieldLabel htmlFor={id("paste")}>{spec.paste.label}</FieldLabel>
                <Input
                  id={id("paste")}
                  value={pasted}
                  onChange={(e) => applyPaste(e.target.value)}
                  placeholder={spec.paste.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                />
                <FieldDescription>{pasteNote ?? "Paste one to fill in the fields. It isn't saved."}</FieldDescription>
              </Field>
            )}

            {rows.map((row) =>
              row.length === 1 ? (
                renderField(row[0])
              ) : (
                <div key={row.map((field) => field.name).join()} className="grid grid-cols-2 gap-3">
                  {row.map(renderField)}
                </div>
              ),
            )}

            {!replacing && spec.help && (
              <details className="group rounded-lg border px-3 py-2 text-sm">
                <summary className="cursor-pointer text-muted-foreground select-none group-open:mb-2">{spec.help.summary}</summary>
                <p className="mb-2 text-xs text-muted-foreground">{spec.help.intro}</p>
                {spec.help.code && (
                  <pre className="overflow-x-auto rounded-md bg-neutral-50 p-2.5 text-[0.6875rem] leading-relaxed">{spec.help.code}</pre>
                )}
                {spec.help.steps && (
                  <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                    {spec.help.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                )}
              </details>
            )}

            {secretMode === "plaintext" && (
              <p className="flex gap-2 text-xs text-muted-foreground">
                <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
                Local development: {spec.secretNoun} are stored unencrypted. Use test credentials.
              </p>
            )}
            {storageMissing && (
              <p role="alert" className="flex gap-2 text-sm text-destructive">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                Secret storage isn&apos;t set up on this server, so {spec.secretNoun} can&apos;t be saved yet.
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
              {pending ? "Testing…" : replacing ? spec.replaceAction : "Test & save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A textarea for a pasted key, with a button that reads the key file instead. The file never leaves the browser but as this text. */
function TextareaWithFile({
  field,
  id,
  value,
  invalid,
  onChange,
}: {
  field: FieldSpec;
  id: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-2">
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        rows={5}
        className="min-h-24 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
      />
      {field.fileAccept && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept={field.fileAccept}
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file && file.size < 20_000) onChange(await file.text());
            }}
          />
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => fileRef.current?.click()}>
            <UploadIcon aria-hidden />
            Upload key file
          </Button>
        </>
      )}
    </div>
  );
}

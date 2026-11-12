"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

type SaveResult = { ok: true } | { ok: false; error: { message: string } };

/**
 * A name edited in place: Enter or clicking away saves, Escape cancels. The
 * new name shows at once; if saving fails it goes back and says why. An
 * empty or unchanged name saves nothing.
 */
export function InlineRename({
  value,
  label,
  maxLength,
  onSave,
  onDone,
  allowEmpty = false,
  className,
}: {
  value: string;
  /** What's being renamed, for screen readers: "App name". */
  label: string;
  maxLength: number;
  onSave: (name: string) => Promise<SaveResult>;
  /** Called with the name now showing, once editing ends. */
  onDone: (shown: string) => void;
  /** Saving an empty value clears it (a description); otherwise empty cancels. */
  allowEmpty?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  async function finish(save: boolean) {
    if (finished.current) return;
    finished.current = true;
    const name = draft.trim();
    if (!save || (!name && !allowEmpty) || name === value) {
      onDone(value);
      return;
    }
    onDone(name);
    const result = await onSave(name);
    if (!result.ok) {
      onDone(value);
      toast.error(result.error.message);
    }
  }

  return (
    <input
      ref={input}
      aria-label={label}
      value={draft}
      maxLength={maxLength}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          void finish(false);
        }
      }}
      // Clicks inside shouldn't reach a row link or menu underneath.
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "min-w-0 rounded-md bg-background px-1.5 outline-none ring-2 ring-ring/40 focus-visible:ring-ring/60",
        className,
      )}
    />
  );
}

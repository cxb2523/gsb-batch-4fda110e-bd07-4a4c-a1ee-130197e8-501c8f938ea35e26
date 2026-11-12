"use client";

import { useState } from "react";

import { updateDashboardAction } from "@/app/(app)/apps/actions";
import { InlineRename } from "@/components/inline-rename";

type Field = "title" | "description";

/**
 * A dashboard's title and description, above it: OpenDashboards' own record, set to
 * the width, padding and ink of the @openuidev/dashboard-library dashboard below (whose
 * own top padding is the gap under it). Click either to change it in
 * place; a saved change shows straight away.
 */
export function DashboardTitle({
  appId,
  dashboard,
}: {
  appId: string;
  dashboard: { id: string; title: string; description: string | null };
}) {
  const [editing, setEditing] = useState<Field | null>(null);
  // Saved values show until the server's copy catches up.
  const [saved, setSaved] = useState<Partial<Record<Field, { from: string; to: string }>>>({});
  const current = { title: dashboard.title, description: dashboard.description ?? "" };
  const shown = (field: Field) => (saved[field]?.from === current[field] ? saved[field].to : current[field]);

  function editor(field: Field, maxLength: number) {
    return (
      <InlineRename
        value={shown(field)}
        label={field === "title" ? "Dashboard name" : "Dashboard description"}
        maxLength={maxLength}
        allowEmpty={field === "description"}
        onSave={(value) => updateDashboardAction({ appId, dashboardId: dashboard.id, [field]: value })}
        onDone={(value) => {
          setSaved((prior) => ({ ...prior, [field]: { from: current[field], to: value } }));
          setEditing(null);
        }}
        // Same type as the heading, and no shift when it turns into a box.
        className="-mx-1.5 w-[calc(100%+0.75rem)] [font:inherit] [letter-spacing:inherit]"
      />
    );
  }

  function display(field: Field, text: string, placeholder?: string) {
    return (
      <button
        type="button"
        onClick={() => setEditing(field)}
        title={field === "title" ? "Rename" : "Edit description"}
        className="-mx-1.5 cursor-text rounded-md px-1.5 text-left [font:inherit] [letter-spacing:inherit] transition-colors hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {text || <span className="text-neutral-400">{placeholder}</span>}
      </button>
    );
  }

  return (
    <div className="@container bg-white text-[#0d0d0d]">
      <header className="mx-auto max-w-[1440px] px-4 pt-5 @min-[721px]:px-9 @min-[721px]:pt-6">
        <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.015em]">
          {editing === "title" ? editor("title", 120) : display("title", shown("title"))}
        </h1>
        <p className="mt-1.5 max-w-[64ch] text-[13.5px] leading-normal text-[#0d0d0d]/64">
          {editing === "description"
            ? editor("description", 300)
            : display("description", shown("description"), "Add a description")}
        </p>
      </header>
    </div>
  );
}

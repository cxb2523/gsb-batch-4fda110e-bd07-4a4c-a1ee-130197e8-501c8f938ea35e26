import { KeyRoundIcon, PlugIcon } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { AddConnectionButton } from "@/components/connections/add-connection-button";
import { ConnectionActions } from "@/components/connections/connection-actions";
import { DemoDatasetSwitch } from "@/components/connections/demo-dataset-switch";
import type { SecretMode } from "@/components/connections/connection-form-dialog";
import { SourceTile } from "@/components/connections/source-tile";
import { UsedBy } from "@/components/connections/used-by";
import { EmptyState, PageHeader, SectionLabel } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth/user";
import { getConnectionService, type ConnectionSummary, type DemoDatasetSummary } from "@/lib/connections";
import { SOURCE_OPTIONS } from "@/lib/sources/catalog";
import type { ConnectionStatus } from "@/lib/db/schema";
import { formatRelative } from "@/lib/format";
import { getSecretMode } from "@/lib/secrets";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Data Connections" };

export default function ConnectionsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-12">
      <PageHeader
        title="Data Connections"
        description="Connect your analytics and databases. OpenDashboards only runs read-only queries against them to build live dashboards."
      />
      <Suspense fallback={<ConnectionsSkeleton />}>
        <ConnectionsContent />
      </Suspense>
    </div>
  );
}

/** Reads the user and their connections, so it streams in behind the boundary. */
async function ConnectionsContent() {
  const user = await requireUser();
  const service = getConnectionService();
  const [all, demos] = await Promise.all([service.list(user.id), service.listDemoDatasets(user.id)]);
  // Installed demo datasets are listed with their switch below, not here.
  const connections = all.filter((connection) => !connection.demo);
  const secretMode = getSecretMode();
  const now = new Date();

  return (
    <>
      <section aria-labelledby="your-connections">
        <SectionLabel id="your-connections">Your connections</SectionLabel>
        {connections.length === 0 ? (
          <EmptyState
            icon={PlugIcon}
            title="No connections yet"
            description="Add a source below to get started."
          />
        ) : (
          <ul className="divide-y rounded-xl border">
            {connections.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                secretMode={secretMode}
                now={now}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="available-sources" className="mt-10">
        <SectionLabel id="available-sources">Available sources</SectionLabel>
        <ul className="divide-y rounded-xl border">
          {SOURCE_OPTIONS.map((source) => (
            <li key={source.key} className="flex items-center gap-3 p-3.5">
              <SourceTile label={source.tile} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{source.label}</p>
                <p className="truncate text-sm text-muted-foreground">{source.blurb}</p>
              </div>
              <AddConnectionButton source={source} secretMode={secretMode} />
            </li>
          ))}
        </ul>
      </section>

      {demos.length > 0 && (
        <section aria-labelledby="demo-datasets" className="mt-10">
          <SectionLabel id="demo-datasets">Demo datasets</SectionLabel>
          <p className="-mt-1 mb-3 text-sm text-muted-foreground">
            Sample data to try OpenDashboards with. Install one to use it like any connection.
          </p>
          <ul className="divide-y rounded-xl border">
            {demos.map((demo) => (
              <DemoRow key={demo.key} demo={demo} />
            ))}
          </ul>
        </section>
      )}

      <StorageNote secretMode={secretMode} />
    </>
  );
}


function ConnectionRow({
  connection,
  secretMode,
  now,
}: {
  connection: ConnectionSummary;
  secretMode: SecretMode;
  now: Date;
}) {
  const details = [
    connection.source,
    connection.detail,
    connection.credentialHint,
    `checked ${formatRelative(connection.lastCheckedAt, now)}`,
  ];

  return (
    <li className="p-3.5">
      <div className="flex items-center gap-3">
        <SourceTile label={connection.tile} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{connection.name}</p>
          <p className="truncate text-sm text-muted-foreground">{details.join(" · ")}</p>
        </div>
        <StatusBadge status={connection.status} />
        <ConnectionActions
          connection={{
            id: connection.id,
            name: connection.name,
            type: connection.type,
            apps: connection.apps,
          }}
          secretMode={secretMode}
        />
      </div>
      <UsedBy apps={connection.apps} />
    </li>
  );
}

function DemoRow({ demo }: { demo: DemoDatasetSummary }) {
  return (
    <li className="p-3.5">
      <div className="flex items-center gap-3">
        <SourceTile label="DM" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{demo.name}</p>
          <p className="line-clamp-2 text-sm text-muted-foreground">{demo.description}</p>
        </div>
        <DemoDatasetSwitch
          dataset={demo.key}
          name={demo.name}
          installed={demo.connectionId !== null}
          apps={demo.apps}
        />
      </div>
      <UsedBy apps={demo.apps} />
    </li>
  );
}

const STATUS: Record<ConnectionStatus, { label: string; dot: string }> = {
  ok: { label: "Connected", dot: "bg-emerald-500" },
  invalid: { label: "Invalid", dot: "bg-red-500" },
  unavailable: { label: "Unavailable", dot: "bg-amber-500" },
};

function StatusBadge({ status }: { status: ConnectionStatus }) {
  const { label, dot } = STATUS[status];
  return (
    <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
      {label}
    </span>
  );
}

function StorageNote({ secretMode }: { secretMode: SecretMode }) {
  const text =
    secretMode === "kms"
      ? "Keys and passwords are encrypted with KMS and never leave the server."
      : secretMode === "plaintext"
        ? "Keys and passwords never leave the server. In local development they're stored unencrypted."
        : "Secret storage isn't set up on this server yet.";
  return (
    <p className="mt-8 flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
      <KeyRoundIcon className="size-3.5 shrink-0" aria-hidden />
      {text}
    </p>
  );
}

function ConnectionsSkeleton() {
  return (
    <div aria-busy className="space-y-10">
      <div>
        <Skeleton className="mb-3 h-4 w-32" />
        <Skeleton className="h-[4.25rem] w-full rounded-xl" />
      </div>
      <div>
        <Skeleton className="mb-3 h-4 w-32" />
        <Skeleton className="h-[4.25rem] w-full rounded-xl" />
      </div>
    </div>
  );
}

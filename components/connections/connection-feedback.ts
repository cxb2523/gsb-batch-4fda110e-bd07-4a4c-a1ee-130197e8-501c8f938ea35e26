import { toast } from "sonner";

import type { ConnectionWarning } from "@/lib/connections";

/** Shows what a successful check found that's still worth knowing. */
export function showConnectionWarnings(warnings: ConnectionWarning[] | undefined) {
  if (warnings?.includes("can_write")) {
    toast.warning("This user can change data", {
      description: "OpenDashboards only runs read-only queries, but a read-only user is safer. Consider switching to one.",
    });
  }
}

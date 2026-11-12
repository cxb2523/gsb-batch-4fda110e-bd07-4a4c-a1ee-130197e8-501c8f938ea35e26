import { OpenUIApiError, ToolExecutionError } from "@openuidev/server";
import { z } from "zod";

import { track } from "@/lib/analytics";
import { getDashboardService, getDashboards } from "@/lib/dashboards";
import { HttpError, readJson, route } from "@/lib/http";
import { addLogContext, logError } from "@/lib/log";

const requestSchema = z.object({
  name: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).optional(),
  id: z.string().min(1).max(200),
  version: z.string().max(200).optional(),
});

/**
 * Runs a live dashboard's data calls. The dashboard must be this user's, and
 * the app its tools record usage against comes from OpenDashboards' own record of
 * the dashboard, never from the request.
 */
export const POST = route(async (request, user) => {
  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, "Invalid interpreter request");

  const dashboard = await getDashboardService().findByArtifact(user.id, parsed.data.id);
  if (!dashboard) throw new HttpError(404, "Dashboard not found");
  addLogContext({ app: dashboard.appId, dashboard: parsed.data.id });

  try {
    const result = await getDashboards().interpreter.execute(
      parsed.data,
      { userId: user.id, appId: dashboard.appId },
      { signal: request.signal },
    );
    return Response.json({ result });
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      track(user.id, "dashboard_query_failed", {
        app_id: dashboard.appId,
        dashboard_id: parsed.data.id,
        tool: parsed.data.name,
        error_code: error.code,
      });
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status ?? 400 });
    }
    if (error instanceof OpenUIApiError) {
      logError("interpreter", error);
      return Response.json({ error: { code: "openui_error", message: error.message } }, { status: 502 });
    }
    throw error;
  }
});

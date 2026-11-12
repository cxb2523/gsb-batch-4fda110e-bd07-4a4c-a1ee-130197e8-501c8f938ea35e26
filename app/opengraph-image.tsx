import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "OpenDashboards: ask any question, get a live dashboard";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  const logo = await readFile(join(process.cwd(), "public/shiro-logo.svg"));
  const logoSrc = `data:image/svg+xml;base64,${logo.toString("base64")}`;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "linear-gradient(180deg, #eef0fb 0%, #ffffff 60%)",
          color: "#171717",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 36, fontWeight: 600 }}>
          <img src={logoSrc} alt="" width={84} height={66} />
          <span style={{ color: "#737373" }}>/</span>
          <span>Dashboards</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 72, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2 }}>
            Ask any question. Get a live dashboard.
          </div>
          <div style={{ fontSize: 32, color: "#525252", lineHeight: 1.3 }}>
            The open-source alternative to Claude Dashboards, across PostHog, your database and any MCP server.
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 28, color: "#737373" }}>opendashboards.com</div>
      </div>
    ),
    size,
  );
}

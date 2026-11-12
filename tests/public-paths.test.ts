import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

describe("isPublicPath", () => {
  it("lets the landing page and its images through", () => {
    for (const path of [
      "/",
      "/icon.svg",
      "/shiro-logo.svg",
      "/robots.txt",
      "/sitemap.xml",
      "/opengraph-image",
      "/landing/dashboards/revenue-light.png",
      "/landing/brand-icons/postgresql-solid.png",
      "/landing/shaders/faded-dither-light-wide.webp",
    ]) {
      expect(isPublicPath(path)).toBe(true);
    }
  });

  it("keeps the app and the API behind sign-in", () => {
    for (const path of ["/apps", "/apps/123", "/connections", "/api/interpreter", "/api/frontend-token", "/api/apps/123/chat"]) {
      expect(isPublicPath(path)).toBe(false);
    }
  });

  it("matches exactly, not by prefix or look-alike", () => {
    for (const path of [
      "",
      "//",
      "/.",
      "/./apps",
      "/icon.svg/apps",
      "/shiro-logo.svg/",
      "/ICON.SVG",
      "/robots.txt/apps",
      "/sitemap.xml.bak",
      "/opengraph-image/apps",
      "/opendashboards",
      "/landing/",
      "/landing",
      "/opendashboards/revenue-light.png",
      "/landing/../apps",
      "/landing/..%2Fapps",
      "/landing/%2e%2e/apps",
      "/landing/..\\apps",
      "/landing//apps",
    ]) {
      expect(isPublicPath(path)).toBe(false);
    }
  });
});

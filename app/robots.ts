import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

/** Only the landing page is for crawlers; everything else needs a signed-in user. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/apps", "/connections", "/kit", "/api/", "/auth/"] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}

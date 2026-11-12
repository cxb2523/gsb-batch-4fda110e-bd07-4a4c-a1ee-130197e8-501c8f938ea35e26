import type { Metadata } from "next";

import { Faq } from "@/components/landing/faq";
import { Footer } from "@/components/landing/footer";
import { Header } from "@/components/landing/header";
import { Hero } from "@/components/landing/hero/hero";
import { LINKS } from "@/components/landing/links";
import { SITE_URL } from "@/lib/site";

import { alt as OG_ALT } from "../opengraph-image";

const TITLE = "OpenDashboards | The open-source alternative to Claude Dashboards";
const DESCRIPTION = "Ask any question across PostHog, your database, and any MCP server. Get a live dashboard.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  // Set in full: a page's openGraph replaces the root layout's, and with it the generated image.
  openGraph: {
    type: "website",
    siteName: "OpenDashboards",
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: OG_ALT }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/opengraph-image"] },
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "OpenDashboards",
  url: SITE_URL,
  description: DESCRIPTION,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  sameAs: [LINKS.github],
  publisher: { "@type": "Organization", name: "Thesys", url: "https://www.thesys.dev" },
};

export default function LandingPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
      <Header />
      <main>
        <Hero />
        <Faq />
      </main>
      <Footer />
    </>
  );
}

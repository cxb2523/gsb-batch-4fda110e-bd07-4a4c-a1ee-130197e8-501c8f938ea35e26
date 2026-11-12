import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SITE_URL } from "@/lib/site";

import "./globals.css";

const inter = Inter({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "OpenDashboards", template: "%s · OpenDashboards" },
  description:
    "Connect PostHog or Postgres and describe what you want to see. OpenDashboards builds live dashboards from your data, and you refine them by chatting.",
  applicationName: "OpenDashboards",
  openGraph: { type: "website", siteName: "OpenDashboards" },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="h-full">
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster theme="light" position="bottom-right" />
      </body>
    </html>
  );
}

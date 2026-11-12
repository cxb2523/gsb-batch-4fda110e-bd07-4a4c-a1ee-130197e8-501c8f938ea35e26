import { Geist } from "next/font/google";
import localFont from "next/font/local";

import "./landing.css";

/* Inter Display for the landing page's headings and buttons; body text stays
   on the app's Inter. */
const interDisplay = localFont({
  src: [
    { path: "./fonts/InterDisplay-Regular.woff2", weight: "400" },
    { path: "./fonts/InterDisplay-Medium.woff2", weight: "500" },
    { path: "./fonts/InterDisplay-SemiBold.woff2", weight: "600" },
  ],
  variable: "--font-display",
  display: "swap",
});

/* Geist for the product name in the top bar. */
const geist = Geist({ variable: "--font-geist", subsets: ["latin"], preload: false });

/** The public landing page: white, light only, outside the signed-in app's shell. */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${interDisplay.variable} ${geist.variable} min-h-dvh overflow-x-clip bg-white text-neutral-950`}>{children}</div>
  );
}

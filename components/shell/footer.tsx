/** The line under the app: what it's built with, linking to OpenUI Cloud. */
export function Footer() {
  return (
    <footer className="flex h-8 shrink-0 items-center justify-center text-xs text-muted-foreground">
      <a
        href="https://www.openui.com/cloud"
        target="_blank"
        rel="noopener"
        className="rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Built with OpenUI Dashboards
      </a>
    </footer>
  );
}

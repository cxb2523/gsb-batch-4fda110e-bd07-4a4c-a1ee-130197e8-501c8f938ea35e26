Project: WikiCrawl, a Wikipedia link-graph explorer. Next.js 14 (app router) + TypeScript, Sigma v3 + graphology for rendering/analysis, @tanstack/react-query, Tailwind, deployed on Vercel (https://wiki-crawl.vercel.app).

Key files: app/page.tsx (state, SSE reader), app/components/{GraphCanvas,SeedSearch,Sidebar,NodeDetailPanel,CrawlControls}.tsx, app/api/crawl/route.ts (SSE crawl), app/api/wikipedia/search/route.ts, lib/{crawler,wikipedia,db,graphAnalysis,layout}.ts, types/graph.ts.

Existing features that must keep working unless a task says otherwise: seed search with suggestions; depth (1-3) and max-nodes (50-500) controls; streaming crawl with progress; community/depth color modes; hover tooltip; click-to-focus highlighting; node detail panel with Expand; sidebar (Top Pages, Clusters); exploration history; shareable URL params (?seed=&depth=&nodes=); zoom/fit/reset controls.

Rules:
- Small, focused commits. Do not refactor unrelated code or restyle the UI unless the task says so.
- Before finishing run: typecheck, lint, tests, and `next build` (if the build fails only because Google Fonts is unreachable in your sandbox, say so and continue).
- Never depend on live Wikipedia in tests; use mocks.
- No new dependency without a one-line justification in the summary.
- Final message: what changed, how you verified it, assumptions made, anything you could not verify.
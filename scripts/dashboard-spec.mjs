// Writes @openuidev/dashboard-library's spec and prompt options for the server: OpenUI
// Cloud generates dashboards against them. The library's components are client modules,
// so the server reads these files instead of importing the package. Regenerated, never edited.
import { mkdirSync, writeFileSync } from "node:fs";

const { library, promptOptions } = await import("@openuidev/dashboard-library");
const { preamble, examples, additionalRules } = promptOptions;

mkdirSync("lib/dashboards/generated", { recursive: true });
writeFileSync("lib/dashboards/generated/dashboard.spec.json", `${JSON.stringify(library.toSpec(), null, 2)}\n`);
writeFileSync(
  "lib/dashboards/generated/dashboard.prompt.json",
  `${JSON.stringify({ preamble, examples, additionalRules }, null, 2)}\n`,
);
console.log("Wrote lib/dashboards/generated/dashboard.spec.json and dashboard.prompt.json");

import { execFileSync } from "node:child_process";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://opendashboards:opendashboards@localhost:54329/opendashboards_test";

/** Recreates the test database's tables from the schema before the suite runs. */
export default function setup() {
  execFileSync("node", ["scripts/db-reset.mjs"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, DB_RESET_QUIET: "1" },
  });
}

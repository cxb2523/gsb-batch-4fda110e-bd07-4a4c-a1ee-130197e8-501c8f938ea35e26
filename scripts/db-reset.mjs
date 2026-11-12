// Drops everything in a local database and recreates the tables by running
// every migration, so tests exercise what production runs. All data is lost.
//
// Usage: pnpm db:reset              (DATABASE_URL from .env.local)
//        DATABASE_URL=… pnpm db:reset

import { execFileSync } from "node:child_process";

import { config } from "dotenv";
import pg from "pg";

config({ path: ".env.local", quiet: true });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const { hostname } = new URL(url);
if (!["localhost", "127.0.0.1", "::1"].includes(hostname) && process.env.ALLOW_REMOTE_RESET !== "1") {
  console.error(`Refusing to reset a non-local database (${hostname}). Set ALLOW_REMOTE_RESET=1 to override.`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(
  "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
);
await client.end();

execFileSync("node", ["scripts/db-migrate.mjs"], {
  stdio: process.env.DB_RESET_QUIET ? "ignore" : "inherit",
  env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url },
});

if (!process.env.DB_RESET_QUIET) console.log(`Reset ${new URL(url).pathname.slice(1)}: all data dropped, tables recreated.`);

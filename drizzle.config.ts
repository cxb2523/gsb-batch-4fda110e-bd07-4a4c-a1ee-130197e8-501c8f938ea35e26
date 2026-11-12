import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// An explicit DATABASE_URL (e.g. the test database) wins over .env.local.
config({ path: ".env.local", quiet: true });

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL! },
});

import { describe, expect, it } from "vitest";

import { SOURCE_OPTIONS } from "@/lib/sources/catalog";
import { flavorOf, postgresCatalog } from "@/lib/sources/postgres/catalog";

describe("flavorOf", () => {
  it("recognizes Supabase and Neon hosts", () => {
    expect(flavorOf("aws-0-us-east-1.pooler.supabase.com")).toBe("supabase");
    expect(flavorOf("db.abcdefghijklmnop.supabase.co")).toBe("supabase");
    expect(flavorOf("EP-Cool-123.us-east-2.aws.neon.tech.")).toBe("neon");
  });

  it("only matches whole domain labels", () => {
    expect(flavorOf("notsupabase.com")).toBeNull();
    expect(flavorOf("supabase.com.evil.example")).toBeNull();
    expect(flavorOf("db.example.com")).toBeNull();
  });
});

describe("postgres describe", () => {
  const base = { port: 5432, database: "postgres", user: "dashboards_reader", sslMode: "require" as const };

  it("labels a connection by the service its host belongs to", () => {
    expect(postgresCatalog.describe({ ...base, host: "aws-0-eu-west-1.pooler.supabase.com" })).toMatchObject({
      source: "Supabase",
      tile: "SB",
    });
    expect(postgresCatalog.describe({ ...base, host: "ep-x.eu-central-1.aws.neon.tech" })).toMatchObject({ source: "Neon", tile: "NE" });
    expect(postgresCatalog.describe({ ...base, host: "db.example.com" })).toMatchObject({ source: "Postgres", tile: "PG" });
  });
});

describe("SOURCE_OPTIONS", () => {
  it("offers each source, then the services that are Postgres underneath", () => {
    expect(SOURCE_OPTIONS.map(({ key, type, flavor }) => [key, type, flavor])).toEqual([
      ["posthog", "posthog", null],
      ["postgres", "postgres", null],
      ["supabase", "postgres", "supabase"],
      ["neon", "postgres", "neon"],
      ["mysql", "mysql", null],
      ["clickhouse", "clickhouse", null],
      ["bigquery", "bigquery", null],
      ["ga4", "ga4", null],
      ["searchconsole", "searchconsole", null],
      ["mcp", "mcp", null],
    ]);
  });
});

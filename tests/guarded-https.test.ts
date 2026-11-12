import { describe, expect, it } from "vitest";

import { guardedHttpsRequest } from "@/lib/net/guarded-https";
import { BlockedAddressError } from "@/lib/net/guarded-socket";

const options = { timeoutMs: 5_000, maxBytes: 1_000 };

describe("guardedHttpsRequest", () => {
  it("refuses plain HTTP", async () => {
    await expect(guardedHttpsRequest(new URL("http://example.com/"), options)).rejects.toThrow(/https/);
  });

  it.each(["https://127.0.0.1/", "https://10.0.0.1/", "https://169.254.169.254/latest/meta-data", "https://[::1]/", "https://[::ffff:10.0.0.1]/"])(
    "refuses %s before connecting",
    async (url) => {
      await expect(guardedHttpsRequest(new URL(url), options)).rejects.toBeInstanceOf(BlockedAddressError);
    },
  );

  it("refuses a name that resolves to a private address", async () => {
    await expect(guardedHttpsRequest(new URL("https://localhost:8443/"), options)).rejects.toBeInstanceOf(BlockedAddressError);
  });
});

import { describe, expect, it } from "vitest";

import { CONNECTION_TYPES } from "@/lib/sources/catalog";
import { connectionTypeEnum } from "@/lib/db/schema";
import {
  BlockedAddressError,
  createGuardedLookup,
  isPublicAddress,
} from "@/lib/net/guarded-socket";

describe("isPublicAddress", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "52.95.110.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ])("allows public %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    // Private networks and loopback.
    ["10.0.0.1", "private"],
    ["172.16.5.4", "private"],
    ["192.168.1.1", "private"],
    ["127.0.0.1", "loopback"],
    ["::1", "loopback"],
    ["fc00::1", "unique local"],
    // Cloud metadata endpoints.
    ["169.254.169.254", "link-local (AWS, GCP, Azure metadata)"],
    ["fd00:ec2::254", "AWS IPv6 metadata"],
    ["100.100.100.200", "CGNAT (Alibaba metadata)"],
    // Everything else that isn't public unicast.
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["255.255.255.255", "broadcast"],
    ["224.0.0.1", "multicast"],
    ["ff02::1", "multicast"],
    ["192.0.2.1", "documentation"],
    ["198.18.0.1", "benchmarking"],
    ["240.0.0.1", "reserved"],
    ["fe80::1", "link-local"],
    // IPv6 forms that carry an IPv4 address.
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["64:ff9b::a9fe:a9fe", "NAT64 of 169.254.169.254"],
    ["2002:a9fe:a9fe::1", "6to4 of 169.254.169.254"],
    ["2001::1", "Teredo"],
    // Not an IP at all.
    ["localhost", "a name"],
    ["0x7f.1", "a non-canonical form"],
  ])("blocks %s (%s)", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe("guarded lookup", () => {
  it("refuses a name that resolves to loopback", async () => {
    const lookup = new Promise<unknown>((resolve, reject) =>
      createGuardedLookup()("localhost", {}, (error, address) => (error ? reject(error) : resolve(address))),
    );
    await expect(lookup).rejects.toBeInstanceOf(BlockedAddressError);
  });
});

it("keeps the database enum in step with the connection types", () => {
  expect([...connectionTypeEnum.enumValues]).toEqual([...CONNECTION_TYPES]);
});

import { describe, it, expect } from "vitest";
import {
  parseMessageCsv,
  parseMessageTimestamp,
} from "@/service/CsvMessageParser";

const HEADER =
  "id,session_id,isoutbox,issaved,send_status,body,posted_at,edited_at,delivered_at,read_at,type,identity";

function csv(...rows) {
  return [HEADER, ...rows].join("\n");
}

describe("parseMessageTimestamp", () => {
  it("accepts integer epoch milliseconds", () => {
    expect(parseMessageTimestamp("1700000000000")).toBe(1700000000000);
    expect(parseMessageTimestamp(1700000000000)).toBe(1700000000000);
    expect(parseMessageTimestamp(" 1700000000000 ")).toBe(1700000000000);
  });

  it("rejects garbage instead of coercing it to 1970", () => {
    expect(parseMessageTimestamp("not-a-number")).toBeNull();
    expect(parseMessageTimestamp("")).toBeNull();
    expect(parseMessageTimestamp(undefined)).toBeNull();
    expect(parseMessageTimestamp(null)).toBeNull();
    expect(parseMessageTimestamp("12.5")).toBeNull();
    expect(parseMessageTimestamp("0x10")).toBeNull();
  });

  it("rejects numeric-looking values that are not valid dates", () => {
    expect(parseMessageTimestamp(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("parseMessageCsv", () => {
  it("counts valid rows as records", () => {
    const result = parseMessageCsv(
      csv(
        "1,s,0,0,SENT,hello,1700000000000,,,,TEXT,ABCDEFGH",
        "2,s,1,0,READ,hi there,1700000060000,,,,TEXT,",
      ),
    );

    expect(result.recordCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.records.map((r) => r.postedAt)).toEqual([
      1700000000000,
      1700000060000,
    ]);
  });

  it("skips rows with missing body and counts them", () => {
    const result = parseMessageCsv(
      csv(
        "1,s,0,0,SENT,,1700000000000,,,,TEXT,ABCDEFGH",
        "2,s,0,0,SENT,real,1700000060000,,,,TEXT,ABCDEFGH",
      ),
    );

    expect(result.recordCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.failedCount).toBe(0);
  });

  it("skips non-TEXT rows and counts them", () => {
    const result = parseMessageCsv(
      csv(
        "1,s,0,0,SENT,pic,1700000000000,,,,IMAGE,ABCDEFGH",
        "2,s,0,0,SENT,voice,1700000060000,,,,VOICEMESSAGE,ABCDEFGH",
        "3,s,0,0,SENT,text,1700000120000,,,,text,ABCDEFGH",
      ),
    );

    expect(result.recordCount).toBe(1);
    expect(result.skippedCount).toBe(2);
    expect(result.failedCount).toBe(0);
  });

  it("fails rows with unparseable posted_at instead of producing 1970 dates", () => {
    const result = parseMessageCsv(
      csv(
        "1,s,0,0,SENT,broken,garbage,,,,TEXT,ABCDEFGH",
        "2,s,0,0,SENT,good,1700000060000,,,,TEXT,ABCDEFGH",
      ),
    );

    expect(result.recordCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].rowNumber).toBe(2);
    expect(result.failures[0].postedAtRaw).toBe("garbage");
    // No accepted record may carry a 1970 timestamp.
    expect(
      result.records.some(
        (r) => new Date(r.postedAt).getUTCFullYear() === 1970,
      ),
    ).toBe(false);
  });

  it("reports 1-based row numbers including the header", () => {
    const result = parseMessageCsv(
      csv("1,s,0,0,SENT,broken,,,,,TEXT,ABCDEFGH"),
    );

    expect(result.failedCount).toBe(1);
    expect(result.failures[0].rowNumber).toBe(2);
  });

  it("handles a header-only file", () => {
    const result = parseMessageCsv(HEADER);
    expect(result.recordCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });
});

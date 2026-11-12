import dayjs from "dayjs";

import {
  collectDataPoints,
  isDataPointFromThisApp,
  isValidDataPointId,
  listDataPoints,
  rollupPageSize,
} from "@/api/datapoints";
import { createSession, logout } from "@/api/auth";
import { GOOGLE_OAUTH_CLIENT_ID } from "@/config";

const FIFTEEN_MINUTES = 900;
const FIVE_MINUTES = 300;
const ONE_MINUTE = 60;
const SECONDS_PER_DAY = 24 * 60 * 60;
const ENCRYPTED_HEALTH_TOKEN_STORAGE_KEY = "auth:encrypted-health-token";
const LIST_DATA_POINTS_PATH = "/dataTypes/steps/dataPoints";

describe("rollupPageSize", () => {
  const start = dayjs("2024-05-07T00:00:00Z");

  it("requests one day of 15-minute distance windows", () => {
    expect(rollupPageSize("distance", "900s", start, start.add(1, "day"))).toBe(
      96,
    );
  });

  it("keeps 15-minute distance windows within 90 days", () => {
    const pageSize = rollupPageSize(
      "distance",
      "900s",
      start,
      start.add(90, "day"),
    );

    expect(pageSize * FIFTEEN_MINUTES).toBeLessThanOrEqual(
      90 * SECONDS_PER_DAY,
    );
    expect(pageSize).toBe(8640);
  });

  it("keeps 5-minute total-calories windows within 14 days", () => {
    const pageSize = rollupPageSize(
      "total-calories",
      "300s",
      start,
      start.add(1, "day"),
    );

    expect(pageSize).toBe(288);
    expect(pageSize * FIVE_MINUTES).toBeLessThanOrEqual(14 * SECONDS_PER_DAY);
  });

  it("caps 1-minute windows at the API page size", () => {
    const pageSize = rollupPageSize(
      "total-calories",
      "60s",
      start,
      start.add(14, "day"),
    );

    expect(pageSize).toBe(10000);
    expect(pageSize * ONE_MINUTE).toBeLessThanOrEqual(14 * SECONDS_PER_DAY);
  });
});

describe("isValidDataPointId", () => {
  it("accepts 4-63 character ids of lowercase letters, numbers, and hyphens", () => {
    expect(isValidDataPointId("abcd")).toBe(true);
    expect(isValidDataPointId("a1b2")).toBe(true);
    expect(isValidDataPointId("banana-split")).toBe(true);
    expect(isValidDataPointId("a1b2c3d4-e5f6-7890-1234-567890abcdef")).toBe(
      true,
    );
    expect(isValidDataPointId("a".repeat(63))).toBe(true);
  });

  it("rejects ids that are too short, too long, or use other characters", () => {
    expect(isValidDataPointId("")).toBe(false);
    expect(isValidDataPointId("abc")).toBe(false);
    expect(isValidDataPointId("a".repeat(64))).toBe(false);
    expect(isValidDataPointId("ABCD")).toBe(false);
    expect(isValidDataPointId("ab_cd")).toBe(false);
    expect(isValidDataPointId("ab/cd")).toBe(false);
    expect(isValidDataPointId("ab cd")).toBe(false);
  });
});

describe("isDataPointFromThisApp", () => {
  it("is true when googleWebClientId matches this app's OAuth client id", () => {
    expect(
      isDataPointFromThisApp({
        dataSource: {
          application: { googleWebClientId: GOOGLE_OAUTH_CLIENT_ID },
        },
      }),
    ).toBe(true);
  });

  it("is false when googleWebClientId is missing or from another app", () => {
    expect(isDataPointFromThisApp({})).toBe(false);
    expect(
      isDataPointFromThisApp({
        dataSource: { application: { googleWebClientId: "other-client" } },
      }),
    ).toBe(false);
  });
});

const ACCOUNT_NOT_LINKED_BODY = {
  error: {
    code: 400,
    message: "The account is not linked to Google Health.",
    status: "FAILED_PRECONDITION",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "ACCOUNT_NOT_LINKED",
        domain: "health.googleapis.com",
      },
    ],
  },
};

/** A page the fake API should return, or a transport-level failure. */
type FakePage =
  | {
      dataPoints?: Array<FakeStepDataPoint>;
      nextPageToken?: string;
      status?: number;
      body?: unknown;
    }
  | { reject: Error };

interface FakeStepDataPoint {
  name?: string;
  steps: { count: string; interval?: { startTime: string } };
}

function stepDataPoint(id: string): FakeStepDataPoint {
  return {
    name: `users/me/dataTypes/steps/dataPoints/${id}`,
    steps: { count: "100" },
  };
}

/**
 * Serve `/auth/health/access` plus one queued fake response per data point
 * page. No test ever reaches the real network.
 */
function mockPagedFetch(fetchMock: jest.SpyInstance, pages: Array<FakePage>) {
  let pageIndex = 0;

  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);

    if (url.includes("/auth/health/access")) {
      return new Response(
        JSON.stringify({ accessToken: "test-token", expiresIn: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes(LIST_DATA_POINTS_PATH)) {
      const page = pages[pageIndex++];

      if (!page) {
        throw new Error("unexpected request past the last fake page");
      }

      if ("reject" in page) {
        throw page.reject;
      }

      const status = page.status ?? 200;
      const body =
        page.body ??
        ({
          dataPoints: page.dataPoints ?? [],
          ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
        } satisfies Record<string, unknown>);

      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("collectDataPoints", () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(async () => {
    // Clear the in-memory session and access token left by earlier suites.
    const logoutFetch = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      await logout();
    } finally {
      logoutFetch.mockRestore();
    }

    const sessionFetch = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          sub: "user-1",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      await createSession("google-id-token");
    } finally {
      sessionFetch.mockRestore();
    }

    localStorage.setItem(ENCRYPTED_HEALTH_TOKEN_STORAGE_KEY, "encrypted-jwt");
    fetchMock = jest.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchMock.mockRestore();
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it("reads every page and reports a complete collection", async () => {
    mockPagedFetch(fetchMock, [
      {
        dataPoints: [stepDataPoint("page-1-a"), stepDataPoint("page-1-b")],
        nextPageToken: "page-2",
      },
      { dataPoints: [stepDataPoint("page-2-a")] },
    ]);

    const result = await collectDataPoints("steps");

    expect(result.complete).toBe(true);
    expect(result.failureReason).toBeUndefined();
    expect(result.dataPoints.map((dataPoint) => dataPoint.name)).toEqual([
      "users/me/dataTypes/steps/dataPoints/page-1-a",
      "users/me/dataTypes/steps/dataPoints/page-1-b",
      "users/me/dataTypes/steps/dataPoints/page-2-a",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps earlier pages and reports a rate limit when a later page returns 429", async () => {
    mockPagedFetch(fetchMock, [
      { dataPoints: [stepDataPoint("page-1")], nextPageToken: "page-2" },
      { status: 429, body: { error: { message: "too many requests" } } },
    ]);
    const dispatchSpy = jest.spyOn(window, "dispatchEvent");

    const result = await collectDataPoints("steps");

    expect(result).toMatchObject({
      complete: false,
      failureReason: "rate-limit",
    });
    expect(result.dataPoints.map((dataPoint) => dataPoint.name)).toEqual([
      "users/me/dataTypes/steps/dataPoints/page-1",
    ]);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "fitbitratelimitexceeded" }),
    );
  });

  it("reports an account-not-linked failure and still dispatches the redirect event", async () => {
    mockPagedFetch(fetchMock, [
      { dataPoints: [stepDataPoint("before-link")], nextPageToken: "page-2" },
      { status: 400, body: ACCOUNT_NOT_LINKED_BODY },
    ]);
    const dispatchSpy = jest.spyOn(window, "dispatchEvent");

    const result = await collectDataPoints("steps");

    expect(result).toMatchObject({
      complete: false,
      failureReason: "account-not-linked",
    });
    expect(result.dataPoints).toHaveLength(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "googlehealthaccountnotlinked" }),
    );
  });

  it("reports other HTTP errors without discarding collected pages", async () => {
    mockPagedFetch(fetchMock, [
      { dataPoints: [stepDataPoint("page-1")], nextPageToken: "page-2" },
      { status: 500, body: { error: { message: "server exploded" } } },
    ]);

    const result = await collectDataPoints("steps");

    expect(result).toMatchObject({
      complete: false,
      failureReason: "http-error",
    });
    expect(result.dataPoints).toHaveLength(1);
  });

  it("reports a network error when the request never gets a response", async () => {
    mockPagedFetch(fetchMock, [{ reject: new TypeError("Failed to fetch") }]);

    const result = await collectDataPoints("steps");

    expect(result).toMatchObject({
      dataPoints: [],
      complete: false,
      failureReason: "network-error",
    });
  });

  it("returns an empty but complete result when there are no data points", async () => {
    mockPagedFetch(fetchMock, [{ dataPoints: [] }]);

    const result = await collectDataPoints("steps");

    expect(result).toEqual({ dataPoints: [], complete: true });
    expect(result.failureReason).toBeUndefined();
  });

  it("returns an empty incomplete result when the first page fails", async () => {
    mockPagedFetch(fetchMock, [{ status: 500, body: {} }]);

    const result = await collectDataPoints("steps");

    expect(result).toMatchObject({
      dataPoints: [],
      complete: false,
      failureReason: "http-error",
    });
  });

  it("stops when the same next page token repeats instead of looping", async () => {
    mockPagedFetch(fetchMock, [
      { dataPoints: [stepDataPoint("page-1")], nextPageToken: "same-token" },
      { dataPoints: [stepDataPoint("page-2")], nextPageToken: "same-token" },
    ]);

    const result = await collectDataPoints("steps");

    expect(result).toMatchObject({
      complete: false,
      failureReason: "pagination-error",
    });
    expect(result.dataPoints).toHaveLength(2);
    // Two page requests; a loop would keep fetching the repeated token.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("listDataPoints", () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(async () => {
    const logoutFetch = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      await logout();
    } finally {
      logoutFetch.mockRestore();
    }

    const sessionFetch = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          sub: "user-1",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      await createSession("google-id-token");
    } finally {
      sessionFetch.mockRestore();
    }

    localStorage.setItem(ENCRYPTED_HEALTH_TOKEN_STORAGE_KEY, "encrypted-jwt");
    fetchMock = jest.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchMock.mockRestore();
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it("still throws and discards pages when a later page fails", async () => {
    mockPagedFetch(fetchMock, [
      { dataPoints: [stepDataPoint("page-1")], nextPageToken: "page-2" },
      { status: 429, body: { error: { message: "too many requests" } } },
    ]);

    await expect(listDataPoints("steps")).rejects.toMatchObject({
      status: 429,
    });
  });
});

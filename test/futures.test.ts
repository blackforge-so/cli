import { describe, it, expect } from "vitest";
import { ApiError, BlackForgeClient } from "../src/client.js";
import { futuresSeriesAtPlanFloor } from "../src/interval.js";
import { bitsFromCatalog, futuresBitsFromCatalog } from "../src/quality.js";
import type { Catalog } from "../src/types.js";

// The futures surface over /v1/futures/*, against a mocked fetch: the right
// path, the right query, the key header, and the API's own errors passed
// through untouched.

function fakeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface Seen {
  path: string;
  query: Record<string, string>;
  key: string | null;
}

function recording(body: unknown = {}, status = 200, headers: Record<string, string> = {}) {
  const seen: Seen[] = [];
  const client = new BlackForgeClient({
    baseUrl: "https://api.example/api",
    apiKey: "bf_test",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      seen.push({
        path: u.pathname,
        query: Object.fromEntries(u.searchParams.entries()),
        key: new Headers(init?.headers).get("x-api-key"),
      });
      return fakeResponse(status, body, headers);
    }) as unknown as typeof fetch,
  });
  return { client, seen };
}

describe("futures client paths and queries", () => {
  it("symbols → /v1/futures/symbols?exchange", async () => {
    const { client, seen } = recording(["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
    const { data } = await client.futuresSymbols("okx");
    expect(data).toEqual(["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
    expect(seen[0]).toEqual({
      path: "/api/v1/futures/symbols",
      query: { exchange: "okx" },
      key: "bf_test",
    });
  });

  it("latest → /v1/futures/latest with columns only when given", async () => {
    const { client, seen } = recording({ ts: 1, values: {} });
    await client.futuresLatest("binance", "BTCUSDT");
    await client.futuresLatest("binance", "BTCUSDT", "markPrice,fundingRate");
    expect(seen[0].path).toBe("/api/v1/futures/latest");
    expect(seen[0].query).toEqual({ exchange: "binance", symbol: "BTCUSDT" });
    expect(seen[1].query).toEqual({
      exchange: "binance",
      symbol: "BTCUSDT",
      columns: "markPrice,fundingRate",
    });
  });

  it("series → /v1/futures/series, unset params left off the URL", async () => {
    const { client, seen } = recording({ points: [] });
    await client.futuresSeries({
      exchange: "bybit",
      symbol: "BTCUSDT",
      metric: "fundingRate",
      interval: "1h",
      from: "2026-11-08T00:00:00Z",
    });
    expect(seen[0].path).toBe("/api/v1/futures/series");
    expect(seen[0].query).toEqual({
      exchange: "bybit",
      symbol: "BTCUSDT",
      metric: "fundingRate",
      interval: "1h",
      from: "2026-11-08T00:00:00Z",
    });
  });

  it("top → /v1/futures/top with the API's own param names", async () => {
    const { client, seen } = recording({ metric: "fundingRate", ts: 1, rows: [] });
    await client.futuresTop({
      metric: "fundingRate",
      baseAsset: "BTC",
      contractType: "perpetual",
      order: "asc",
      limit: "10",
    });
    expect(seen[0].path).toBe("/api/v1/futures/top");
    expect(seen[0].query).toEqual({
      metric: "fundingRate",
      baseAsset: "BTC",
      contractType: "perpetual",
      order: "asc",
      limit: "10",
    });
  });

  it("liquidations → /v1/futures/liquidations, no params means the API's default hour", async () => {
    const { client, seen } = recording({ from: 1, to: 2, events: [] });
    await client.futuresLiquidations({});
    await client.futuresLiquidations({ exchange: "bybit", side: "long", limit: "500" });
    expect(seen[0].path).toBe("/api/v1/futures/liquidations");
    expect(seen[0].query).toEqual({});
    expect(seen[1].query).toEqual({ exchange: "bybit", side: "long", limit: "500" });
  });

  it("every futures route needs a key and says so before the network", async () => {
    const client = new BlackForgeClient({
      baseUrl: "https://api.example",
      fetchImpl: (async () => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    });
    for (const call of [
      () => client.futuresSymbols("okx"),
      () => client.futuresLatest("binance", "BTCUSDT"),
      () => client.futuresSeries({ exchange: "binance", symbol: "BTCUSDT", metric: "markPrice" }),
      () => client.futuresTop({ metric: "fundingRate" }),
      () => client.futuresLiquidations({}),
    ]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(401);
      expect(err.serverMessage).toContain("No API key");
    }
  });

  it("passes the liquidations 403 through with its upgrade URL", async () => {
    const { client } = recording(
      {
        message:
          "Liquidation events are not included in the pro plan. Upgrade at https://blackforge.so/pricing for the liquidation feed.",
      },
      403,
    );
    const err = await client.futuresLiquidations({}).catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.serverMessage).toContain("https://blackforge.so/pricing");
  });

  it("surfaces Columns-Omitted on a futures latest", async () => {
    const { client } = recording({ ts: 1, values: { markPrice: 1 } }, 200, {
      "x-blackforge-columns-omitted": "liqLongCount,liqShortCount",
    });
    const { meta } = await client.futuresLatest("binance", "BTCUSDT", "markPrice,liqLongCount,liqShortCount");
    expect(meta.columnsOmitted).toBe("liqLongCount,liqShortCount");
  });
});

describe("futuresSeriesAtPlanFloor", () => {
  const PARAMS = {
    exchange: "bybit",
    symbol: "BTCUSDT",
    metric: "fundingRate",
    from: "2026-11-08T00:00:00Z",
    to: "2026-11-09T00:00:00Z",
  };

  function scripted(answers: Record<string, () => Response>) {
    const asked: string[] = [];
    const client = new BlackForgeClient({
      baseUrl: "https://api.example",
      apiKey: "bf_test",
      fetchImpl: (async (url: string) => {
        const u = new URL(url);
        expect(u.pathname).toBe("/v1/futures/series");
        const interval = u.searchParams.get("interval") ?? "";
        asked.push(interval);
        const answer = answers[interval];
        if (!answer) throw new Error(`unexpected interval ${interval}`);
        return answer();
      }) as unknown as typeof fetch,
    });
    return { client, asked };
  }

  it("serves 1m when the plan allows it", async () => {
    const { client, asked } = scripted({
      "1m": () => fakeResponse(200, { points: [{ ts: 1, value: 0.0001 }] }),
    });
    const got = await futuresSeriesAtPlanFloor(client, PARAMS);
    expect(asked).toEqual(["1m"]);
    expect(got.interval).toBe("1m");
  });

  it("steps to the floor the 403 names (pro: 1h)", async () => {
    const { client, asked } = scripted({
      "1m": () =>
        fakeResponse(403, {
          message:
            "The 1m interval is finer than the pro plan's 1h granularity. Upgrade at https://blackforge.so/pricing for finer buckets.",
        }),
      "1h": () => fakeResponse(200, { points: [{ ts: 1, value: 0.0001 }] }),
    });
    const got = await futuresSeriesAtPlanFloor(client, PARAMS);
    expect(asked).toEqual(["1m", "1h"]);
    expect(got.interval).toBe("1h");
  });

  it("does NOT re-ask at 5m on an empty 1m answer (futures rows are minute rows from day one)", async () => {
    const { client, asked } = scripted({
      "1m": () => fakeResponse(200, { points: [] }),
    });
    const got = await futuresSeriesAtPlanFloor(client, PARAMS);
    expect(asked).toEqual(["1m"]);
    expect(got.result.data.points).toEqual([]);
  });

  it("rethrows any other error", async () => {
    const { client } = scripted({
      "1m": () =>
        fakeResponse(403, { message: "The kucoin venue is not included in the free plan." }),
    });
    const err = await futuresSeriesAtPlanFloor(client, PARAMS).catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.serverMessage).toContain("kucoin");
  });
});

describe("the futures decode table", () => {
  const catalog: Catalog = {
    venues: [],
    metrics: [
      {
        key: "qualityFlags",
        label: "",
        family: "quality",
        unit: "bitmask",
        quoteRelative: false,
        nullable: false,
        description: "",
        howToRead: "",
        minPlan: "free",
        bits: [{ bit: 0, name: "BOOK_DESYNCED" }],
      },
    ],
    futures: {
      venues: [],
      metrics: [],
      qualityBits: [{ bit: 0, mask: 1, name: "QUOTE_MISSING" }],
    },
  };

  it("reads futures.qualityBits, never the spot table", () => {
    expect(futuresBitsFromCatalog(catalog).map((b) => b.name)).toEqual(["QUOTE_MISSING"]);
    expect(bitsFromCatalog(catalog).map((b) => b.name)).toEqual(["BOOK_DESYNCED"]);
  });

  it("is empty when the API serves no futures", () => {
    expect(futuresBitsFromCatalog({ venues: [], metrics: [] })).toEqual([]);
  });
});

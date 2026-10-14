import { describe, it, expect } from "vitest";
import { ApiError, BlackForgeClient } from "../src/client.js";
import { floorFromIntervalError, seriesAtPlanFloor } from "../src/interval.js";

function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const FINER = (plan: string, floor: string) => ({
  message: `The 1m interval is finer than the ${plan} plan's ${floor} granularity. Upgrade at https://blackforge.so/pricing for finer buckets.`,
});

function scripted(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  const client = new BlackForgeClient({
    baseUrl: "https://api.example",
    apiKey: "bf_test",
    fetchImpl: (async (url: string) => {
      const interval = new URL(url).searchParams.get("interval") ?? "";
      asked.push(interval);
      const answer = answers[interval];
      if (!answer) throw new Error(`unexpected interval ${interval}`);
      return answer();
    }) as unknown as typeof fetch,
  });
  return { client, asked };
}

const PARAMS = {
  exchange: "binance",
  symbol: "BTCUSDT",
  metric: "price",
  from: "2026-10-01T00:00:00Z",
  to: "2026-10-01T01:00:00Z",
};
const points = (n: number) => ({
  metric: "price",
  exchange: "binance",
  symbol: "BTCUSDT",
  points: Array.from({ length: n }, (_, i) => ({ ts: i * 60_000, value: 1 })),
});

describe("floorFromIntervalError", () => {
  it("reads the plan floor from the API's 403", () => {
    expect(floorFromIntervalError(new ApiError(403, FINER("max", "5m").message))).toBe("5m");
    expect(floorFromIntervalError(new ApiError(403, FINER("free", "1h").message))).toBe("1h");
  });
  it("falls back to 5m when the floor cannot be parsed", () => {
    expect(floorFromIntervalError(new ApiError(403, "The 1m interval is finer than allowed."))).toBe("5m");
  });
  it("ignores every other error", () => {
    expect(floorFromIntervalError(new ApiError(403, "The okx venue is not included in the free plan."))).toBeNull();
    expect(floorFromIntervalError(new ApiError(400, "interval is finer than"))).toBeNull();
    expect(floorFromIntervalError(new Error("boom"))).toBeNull();
  });
});

describe("seriesAtPlanFloor", () => {
  it("serves 1m in one request on a 1m plan", async () => {
    const { client, asked } = scripted({ "1m": () => fakeResponse(200, points(60)) });
    const out = await seriesAtPlanFloor(client, PARAMS);
    expect(asked).toEqual(["1m"]);
    expect(out.interval).toBe("1m");
    expect(out.result.data.points).toHaveLength(60);
    expect(out.note).toBeNull();
  });

  it("retries at the floor the 403 names on a coarser plan", async () => {
    const { client, asked } = scripted({
      "1m": () => fakeResponse(403, FINER("max", "5m")),
      "5m": () => fakeResponse(200, points(12)),
    });
    const out = await seriesAtPlanFloor(client, PARAMS);
    expect(asked).toEqual(["1m", "5m"]);
    expect(out.interval).toBe("5m");
    expect(out.note).toBeNull();
  });

  it("falls back to 5m with a note when the range predates the minute rows", async () => {
    const { client, asked } = scripted({
      "1m": () => fakeResponse(200, points(0)),
      "5m": () => fakeResponse(200, points(12)),
    });
    const out = await seriesAtPlanFloor(client, PARAMS);
    expect(asked).toEqual(["1m", "5m"]);
    expect(out.interval).toBe("5m");
    expect(out.note).toMatch(/one-minute rows/);
  });

  it("does not retry an unentitled column", async () => {
    const { client, asked } = scripted({
      "1m": () => fakeResponse(200, points(0), { "x-blackforge-columns-omitted": "price" }),
    });
    const out = await seriesAtPlanFloor(client, PARAMS);
    expect(asked).toEqual(["1m"]);
    expect(out.interval).toBe("1m");
  });

  it("rethrows any other error", async () => {
    const { client } = scripted({
      "1m": () => fakeResponse(403, { message: "The okx venue is not included in the free plan." }),
    });
    await expect(seriesAtPlanFloor(client, PARAMS)).rejects.toMatchObject({ status: 403 });
  });
});

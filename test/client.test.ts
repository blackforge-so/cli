import { describe, it, expect } from "vitest";
import { ApiError, BlackForgeClient } from "../src/client.js";

// A minimal fake Response good enough for the client's request() path.
function fakeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers(headers),
    text: async () => text,
  } as unknown as Response;
}

function clientWith(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  apiKey = "bf_test",
) {
  return new BlackForgeClient({
    baseUrl: "https://api.example",
    apiKey,
    fetchImpl: impl as unknown as typeof fetch,
  });
}

describe("BlackForgeClient error translation", () => {
  it("translates a 400 into an ApiError carrying the status and server message", async () => {
    const client = clientWith(async () =>
      fakeResponse(400, { message: "Unknown metric: microprice" }),
    );
    await expect(
      client.series({ exchange: "binance", symbol: "BTCUSDT", metric: "x" }),
    ).rejects.toMatchObject({
      status: 400,
      serverMessage: "Unknown metric: microprice",
    });
  });

  it("translates a 402 (quota) into an ApiError", async () => {
    const client = clientWith(async () =>
      fakeResponse(402, { message: "Monthly row quota exhausted." }),
    );
    const err = await client.usage().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(402);
    expect(err.serverMessage).toContain("quota");
  });

  it("translates a 403 (venue not in plan) with the upgrade URL preserved", async () => {
    const client = clientWith(async () =>
      fakeResponse(403, {
        message:
          "The okx venue is not included in the free plan. Upgrade at https://blackforge.so/pricing to query all 9 venues.",
      }),
    );
    const err = await client.symbols("okx").catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.serverMessage).toContain("https://blackforge.so/pricing");
  });

  it("requires a key for keyed endpoints and fails clearly without one", async () => {
    const client = new BlackForgeClient({ baseUrl: "https://api.example" });
    const err = await client.symbols("binance").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.serverMessage).toContain("No API key");
  });

  it("does not require a key for the keyless catalog endpoint", async () => {
    let sawKeyHeader = true;
    const client = new BlackForgeClient({
      baseUrl: "https://api.example",
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        sawKeyHeader = headers.has("x-api-key");
        return fakeResponse(200, { venues: [], metrics: [] });
      }) as unknown as typeof fetch,
    });
    const { data } = await client.catalog();
    expect(data).toEqual({ venues: [], metrics: [] });
    expect(sawKeyHeader).toBe(false);
  });

  it("surfaces the X-BlackForge-* metering headers as meta", async () => {
    const client = clientWith(async () =>
      fakeResponse(
        200,
        { metric: "upDepth30", exchange: "binance", symbol: "BTCUSDT", points: [] },
        {
          "x-blackforge-rows-served": "13",
          "x-blackforge-rows-remaining": "49999946",
          "x-blackforge-columns-omitted": "1",
        },
      ),
    );
    const { meta } = await client.series({
      exchange: "binance",
      symbol: "BTCUSDT",
      metric: "upDepth30",
    });
    expect(meta.rowsServed).toBe("13");
    expect(meta.rowsRemaining).toBe("49999946");
    expect(meta.columnsOmitted).toBe("1");
  });

  it("wraps a network failure into an ApiError with status 0", async () => {
    const client = clientWith(async () => {
      throw new Error("ECONNREFUSED");
    });
    const err = await client.usage().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.serverMessage).toContain("Could not reach");
  });
});

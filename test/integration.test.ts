import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// End-to-end: run the BUILT binary as a child process against the LOCAL API.
// Requires `npm run build` first and the local dev API from Prompt 1 running at
// http://localhost:3001/api. If either is missing the suite skips (with a note)
// rather than failing a machine that has no local stack.

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "dist", "cli.js");
const BASE = process.env.BLACKFORGE_TEST_BASE ?? "http://localhost:3001/api";
const MAX_KEY = "bf_demoMaxKey_0000000000000000";
const FREE_KEY = "bf_freeSeedKey_0000000000000000";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], envOverride: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { env: { ...process.env, NO_COLOR: "1", ...envOverride }, timeout: 20_000 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code as number)
            : err
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

let apiUp = false;

beforeAll(async () => {
  if (!existsSync(BIN)) {
    throw new Error(`Built binary missing at ${BIN}. Run \`npm run build\` first.`);
  }
  try {
    const res = await fetch(`${BASE}/v1/catalog`);
    apiUp = res.ok;
  } catch {
    apiUp = false;
  }
  if (!apiUp) {
    // eslint-disable-next-line no-console
    console.warn(
      `[integration] local API not reachable at ${BASE} — skipping child-process integration tests.`,
    );
  }
}, 20_000);

describe("blackforge binary against the local API", () => {
  it("prints all commands in --help", async () => {
    const { code, stdout } = await cli(["--help"]);
    expect(code).toBe(0);
    for (const cmd of [
      "login",
      "auth",
      "catalog",
      "venues",
      "metrics",
      "symbols",
      "latest",
      "series",
      "usage",
      "futures",
    ]) {
      expect(stdout).toContain(cmd);
    }
  });

  it("lists the futures subcommands in futures --help", async () => {
    const { code, stdout } = await cli(["futures", "--help"]);
    expect(code).toBe(0);
    for (const cmd of ["symbols", "latest", "series", "top", "liquidations"]) {
      expect(stdout).toContain(cmd);
    }
  });

  it("catalog works keyless and returns 9 venues", async ({ skip }) => {
    if (!apiUp) return skip();
    const { code, stdout } = await cli([
      "catalog",
      "--base-url",
      BASE,
      "--output",
      "json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.venues).toHaveLength(9);
    expect(parsed.metrics.length).toBeGreaterThan(50);
  });

  it("symbols --exchange binance returns pairs (max key)", async ({ skip }) => {
    if (!apiUp) return skip();
    const { code, stdout } = await cli([
      "symbols",
      "-e",
      "binance",
      "--api-key",
      MAX_KEY,
      "--base-url",
      BASE,
      "--output",
      "json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toContain("BTCUSDT");
  });

  it("latest --output json returns a values object", async ({ skip }) => {
    if (!apiUp) return skip();
    const { code, stdout } = await cli([
      "latest",
      "-e",
      "binance",
      "-s",
      "BTCUSDT",
      "--api-key",
      MAX_KEY,
      "--base-url",
      BASE,
      "--output",
      "json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(typeof parsed.values).toBe("object");
    expect(typeof parsed.ts).toBe("number");
  });

  it("series --output csv yields a header plus data rows", async ({ skip }) => {
    if (!apiUp) return skip();
    const { code, stdout } = await cli([
      "series",
      "-e",
      "binance",
      "-s",
      "BTCUSDT",
      "-m",
      "upDepth30",
      "-i",
      "5m",
      "--from",
      "2026-07-01T00:00:00Z",
      "--to",
      "2026-07-01T01:00:00Z",
      "--api-key",
      MAX_KEY,
      "--base-url",
      BASE,
      "--output",
      "csv",
    ]);
    expect(code).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toBe("ts,value");
    expect(lines.length).toBeGreaterThan(1);
    // Each data row is `<iso>,<number>`.
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z,/);
  });

  it("usage --output json returns a days array", async ({ skip }) => {
    if (!apiUp) return skip();
    const { code, stdout } = await cli([
      "usage",
      "--api-key",
      MAX_KEY,
      "--base-url",
      BASE,
      "--output",
      "json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed.days)).toBe(true);
  });

  it("free key hitting okx exits non-zero with a 403 message", async ({ skip }) => {
    if (!apiUp) return skip();
    const { code, stderr } = await cli([
      "symbols",
      "-e",
      "okx",
      "--api-key",
      FREE_KEY,
      "--base-url",
      BASE,
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("403");
    expect(stderr.toLowerCase()).toContain("not included in the free plan");
  });

  it("a keyed command with no resolvable key fails clearly", async ({ skip }) => {
    if (!apiUp) return skip();
    // Isolate credential resolution: point HOME/USERPROFILE at an empty temp dir
    // (no ~/.blackforge/config.json) and clear the env key, so no flag/env/config
    // key exists regardless of the developer's real machine state.
    const emptyHome = mkdtempSync(join(tmpdir(), "bf-cli-nohome-"));
    const { code, stderr } = await cli(
      ["usage", "--base-url", BASE],
      { HOME: emptyHome, USERPROFILE: emptyHome, BLACKFORGE_API_KEY: "" },
    );
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("no api key");
  });
});

// ── the quality surface, against a stub API ─────────────────────────────────
// These run everywhere: a tiny in-process HTTP server stands in for /v1, so the
// real binary's output is asserted without a local BlackForge stack. The first
// test is the one that matters most — today's API sends no `quality`, and the
// output must be exactly what it was before the field existed.

const CATALOG_WITH_BITS = {
  venues: [],
  metrics: [
    {
      key: "qualityFlags",
      label: "Quality flags",
      family: "quality",
      unit: "bitmask",
      quoteRelative: false,
      nullable: false,
      description: "",
      howToRead: "",
      minPlan: "free",
      bits: [
        { bit: 0, name: "BOOK_DESYNCED" },
        { bit: 1, name: "BOOK_CROSSED" },
        { bit: 11, name: "EVENTS_LOST" },
      ],
    },
  ],
};

async function withStubApi(
  bodies: { latest?: unknown; series?: unknown },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const body = url.pathname.endsWith("/v1/latest")
      ? bodies.latest
      : url.pathname.endsWith("/v1/series")
        ? bodies.series
        : CATALOG_WITH_BITS;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}/api`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const CLEAN_SERIES = {
  metric: "upDepth30",
  exchange: "binance",
  symbol: "BTCUSDT",
  points: [
    { ts: 1785162300000, value: 123.4 },
    { ts: 1785162600000, value: 118.9 },
  ],
};

const FLAGGED_SERIES = {
  metric: "upDepth30",
  exchange: "binance",
  symbol: "BTCUSDT",
  points: [
    { ts: 1785162300000, value: 123.4, quality: 0, qualityAll: 0 },
    { ts: 1785162600000, value: 118.9, quality: 2049, qualityAll: 0 },
    { ts: 1785162900000, value: 120.1, quality: 32768, qualityAll: 32768 },
  ],
};

function latestArgs(base: string, extra: string[] = []): string[] {
  return [
    "latest", "-e", "binance", "-s", "BTCUSDT",
    "--api-key", MAX_KEY, "--base-url", base, ...extra,
  ];
}

function seriesArgs(base: string, extra: string[] = []): string[] {
  return [
    "series", "-e", "binance", "-s", "BTCUSDT", "-m", "upDepth30",
    "--api-key", MAX_KEY, "--base-url", base, ...extra,
  ];
}

describe("quality surface (stub API)", () => {
  it("no quality on the wire → output is byte-identical to today's", async () => {
    await withStubApi(
      { latest: { ts: 1785162300000, values: { bestBid: 118240.1 } }, series: CLEAN_SERIES },
      async (base) => {
        const table = await cli(latestArgs(base, ["--output", "table"]));
        expect(table.code).toBe(0);
        expect(table.stdout).not.toContain("quality");
        expect(table.stdout.split("\n")[0]).toBe("ts 2026-07-27T14:25:00.000Z");

        const json = await cli(latestArgs(base, ["--output", "json"]));
        expect(JSON.parse(json.stdout)).toEqual({
          ts: 1785162300000,
          values: { bestBid: 118240.1 },
        });

        const csv = await cli(seriesArgs(base, ["--output", "csv"]));
        expect(csv.code).toBe(0);
        expect(csv.stdout.trim().split("\n")[0]).toBe("ts,value");
        expect(csv.stderr).toBe("");

        const seriesTable = await cli(seriesArgs(base, ["--output", "table"]));
        expect(seriesTable.stdout).not.toContain("quality");
        expect(seriesTable.stderr).toBe("");
      },
    );
  });

  it("latest table prints a quality header line when the row is flagged", async () => {
    await withStubApi(
      {
        latest: {
          ts: 1785162300000,
          values: { bestBid: 118240.1, qualityFlags: 6 },
          quality: {
            raw: 6,
            all: 6,
            flags: ["BOOK_DESYNCED", "BOOK_CROSSED"],
            contaminates: ["bookMicro", "bookWalls", "orderLadders"],
            observedAt: 1785162298412,
          },
        },
      },
      async (base) => {
        const { code, stdout } = await cli(latestArgs(base, ["--output", "table"]));
        expect(code).toBe(0);
        expect(stdout).toContain(
          "quality  BOOK_DESYNCED, BOOK_CROSSED — affects bookMicro, bookWalls, orderLadders",
        );
      },
    );
  });

  it("latest table says ok when clean and unknown on the 32768 sentinel", async () => {
    await withStubApi(
      {
        latest: {
          ts: 1785162300000,
          values: { bestBid: 1 },
          quality: { raw: 0, all: 0, flags: [], contaminates: [] },
        },
      },
      async (base) => {
        const { stdout } = await cli(latestArgs(base, ["--output", "table"]));
        expect(stdout).toContain("quality  ok");
      },
    );
    await withStubApi(
      {
        latest: {
          ts: 1785162300000,
          values: { bestBid: 1 },
          quality: { raw: 32768, all: 32768, flags: [], contaminates: [] },
        },
      },
      async (base) => {
        const { stdout } = await cli(latestArgs(base, ["--output", "table"]));
        expect(stdout).toContain("quality  unknown (row predates the quality rail)");
        expect(stdout.toLowerCase()).not.toContain("warn");
      },
    );
  });

  it("series writes one aggregate note to stderr and leaves stdout untouched", async () => {
    await withStubApi({ series: FLAGGED_SERIES }, async (base) => {
      const { code, stdout, stderr } = await cli(seriesArgs(base, ["--output", "csv"]));
      expect(code).toBe(0);
      expect(stderr.trim()).toBe(
        "note: 1 of 3 buckets flagged — BOOK_DESYNCED (1), EVENTS_LOST (1). " +
          "Re-run with --quality for a per-bucket column.",
      );
      // stdout keeps the pinned two-column CSV schema.
      expect(stdout.trim().split("\n")[0]).toBe("ts,value");
    });
  });

  it("--quality adds the per-bucket column to csv and table", async () => {
    await withStubApi({ series: FLAGGED_SERIES }, async (base) => {
      const csv = await cli(seriesArgs(base, ["--quality", "--output", "csv"]));
      const lines = csv.stdout.trim().split("\n");
      expect(lines[0]).toBe("ts,value,quality");
      expect(lines[1]).toBe("2026-07-27T14:25:00.000Z,123.4,");
      expect(lines[2]).toBe('2026-07-27T14:30:00.000Z,118.9,"BOOK_DESYNCED, EVENTS_LOST"');
      expect(lines[3]).toBe("2026-07-27T14:35:00.000Z,120.1,unknown");
      // the hint to re-run is dropped once --quality is on
      expect(csv.stderr).not.toContain("Re-run");

      const table = await cli(seriesArgs(base, ["--quality", "--output", "table"]));
      expect(table.stdout).toContain("quality");
      expect(table.stdout).toContain("BOOK_DESYNCED, EVENTS_LOST");
    });
  });

  it("an all-unknown archive stays silent — no note, no shouting", async () => {
    await withStubApi(
      {
        series: {
          ...CLEAN_SERIES,
          points: CLEAN_SERIES.points.map((p) => ({ ...p, quality: 32768, qualityAll: 32768 })),
        },
      },
      async (base) => {
        const { stdout, stderr } = await cli(seriesArgs(base, ["--output", "csv"]));
        expect(stderr).toBe("");
        expect(stdout.trim().split("\n")[0]).toBe("ts,value");
      },
    );
  });

  it("--output json carries the quality key through verbatim", async () => {
    const quality = {
      raw: 6,
      all: 6,
      flags: ["BOOK_DESYNCED", "BOOK_CROSSED"],
      contaminates: ["bookMicro"],
      observedAt: 1785162298412,
    };
    await withStubApi(
      { latest: { ts: 1785162300000, values: { bestBid: 1 }, quality } },
      async (base) => {
        const { stdout } = await cli(latestArgs(base, ["--output", "json"]));
        expect(JSON.parse(stdout).quality).toEqual(quality);
      },
    );
  });
});

// ── futures, against a stub API ─────────────────────────────────────────────
// /v1/futures/* and a catalog carrying the `futures` block. Runs everywhere.

const FUTURES_CATALOG = {
  venues: [{ venue: "binance", minPlan: "free" }],
  metrics: [
    {
      key: "qualityFlags",
      label: "Quality flags",
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
    venues: [
      { venue: "binance", minPlan: "free", liquidations: "lowerBound" },
      { venue: "bybit", minPlan: "pro", liquidations: "complete" },
      { venue: "mexc", minPlan: "free", liquidations: null },
    ],
    metrics: [
      { key: "markPrice", label: "Mark price", family: "price", unit: "price", minPlan: "free" },
      { key: "fundingRate", label: "Funding rate", family: "funding", unit: "ratio", minPlan: "free" },
      { key: "liqLongCount", label: "Long liquidations", family: "liquidations", unit: "count", minPlan: "max" },
      { key: "rowVersion", label: "Row version", family: "quality", unit: "count", minPlan: null, internal: true },
    ],
    qualityBits: [
      { bit: 0, mask: 1, name: "QUOTE_MISSING", contaminates: ["price", "funding", "openInterest"] },
      { bit: 1, mask: 2, name: "TRADES_PARTIAL", contaminates: ["tradeFlow"] },
    ],
    liquidationEvents: { minPlan: "max", fields: [] },
    availableFrom: "2026-11-07T22:04:00.000Z",
    historyDays: 60,
  },
};

async function withFuturesStub(
  routes: Record<string, { status?: number; body: unknown }>,
  fn: (base: string, seen: string[]) => Promise<void>,
): Promise<void> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    seen.push(url.pathname + url.search);
    const route = Object.entries(routes).find(([suffix]) => url.pathname.endsWith(suffix));
    const { status, body } = route ? route[1] : { status: 200, body: FUTURES_CATALOG };
    res.writeHead(status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}/api`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const keyed = (base: string) => ["--api-key", MAX_KEY, "--base-url", base];

describe("futures commands (stub API)", () => {
  it("futures latest: table header, quality line, text values, raw JSON", async () => {
    const body = {
      ts: 1793145600000,
      interval: "1m",
      values: { baseAsset: "BTC", contractType: "perpetual", markPrice: 101234.5, fundingRate: 0.0001 },
      quality: { raw: 2, all: 2, flags: ["TRADES_PARTIAL"], contaminates: ["tradeFlow"] },
    };
    await withFuturesStub({ "/v1/futures/latest": { body } }, async (base, seen) => {
      const table = await cli(["futures", "latest", "-e", "binance", "-s", "BTCUSDT", ...keyed(base), "--output", "table"]);
      expect(table.code).toBe(0);
      expect(table.stdout.split("\n")[0]).toBe("ts 2026-10-28T00:00:00.000Z  (1m bucket)");
      expect(table.stdout).toContain("quality  TRADES_PARTIAL — affects tradeFlow");
      expect(table.stdout).toContain("perpetual");
      expect(seen[0]).toContain("/v1/futures/latest?exchange=binance&symbol=BTCUSDT");

      const json = await cli(["futures", "latest", "-e", "binance", "-s", "BTCUSDT", ...keyed(base), "--output", "json"]);
      expect(JSON.parse(json.stdout)).toEqual(body);
    });
  });

  it("futures latest with no row says so instead of printing 1970", async () => {
    await withFuturesStub({ "/v1/futures/latest": { body: { ts: 0, values: {} } } }, async (base) => {
      const { code, stdout } = await cli(["futures", "latest", "-e", "okx", "-s", "NOPE-USDT-SWAP", ...keyed(base), "--output", "table"]);
      expect(code).toBe(0);
      expect(stdout).toContain("no row for this contract");
      expect(stdout).not.toContain("1970");
    });
  });

  it("futures series: csv, futures bit names in the note, never the spot table", async () => {
    const body = {
      metric: "fundingRate",
      exchange: "bybit",
      symbol: "BTCUSDT",
      interval: "1h",
      points: [
        { ts: 1793145600000, value: 0.0001, quality: 0, qualityAll: 0 },
        { ts: 1793149200000, value: null, quality: 1, qualityAll: 0 },
      ],
    };
    await withFuturesStub({ "/v1/futures/series": { body } }, async (base, seen) => {
      const csv = await cli([
        "futures", "series", "-e", "bybit", "-s", "BTCUSDT", "-m", "fundingRate", "-i", "1h",
        "--from", "2026-11-08T00:00:00Z", "--to", "2026-11-09T00:00:00Z", ...keyed(base), "--output", "csv",
      ]);
      expect(csv.code).toBe(0);
      const lines = csv.stdout.trim().split("\n");
      expect(lines[0]).toBe("ts,value");
      expect(lines[1]).toBe("2026-10-28T00:00:00.000Z,0.0001");
      expect(lines[2]).toBe("2026-10-28T01:00:00.000Z,");
      expect(csv.stderr).toContain("QUOTE_MISSING (1)");
      expect(csv.stderr).not.toContain("BOOK_DESYNCED");
      expect(seen.some((u) => u.includes("/v1/futures/series?") && u.includes("interval=1h"))).toBe(true);

      const q = await cli([
        "futures", "series", "-e", "bybit", "-s", "BTCUSDT", "-m", "fundingRate", "-i", "1h",
        ...keyed(base), "--quality", "--output", "csv",
      ]);
      expect(q.stdout.trim().split("\n")[2]).toBe("2026-10-28T01:00:00.000Z,,QUOTE_MISSING");
    });
  });

  it("futures top: one row per contract, header names metric and bucket", async () => {
    const body = {
      metric: "fundingRate",
      interval: "1h",
      ts: 1793145600000,
      order: "desc",
      rows: [
        { exchange: "bybit", symbol: "BTCUSDT", baseAsset: "BTC", value: 0.00012 },
        { exchange: "okx", symbol: "BTC-USDT-SWAP", baseAsset: "BTC", value: 0.0001 },
      ],
    };
    await withFuturesStub({ "/v1/futures/top": { body } }, async (base, seen) => {
      const csv = await cli(["futures", "top", "-m", "fundingRate", "-b", "BTC", "--contract-type", "perpetual", "-n", "2", ...keyed(base), "--output", "csv"]);
      expect(csv.code).toBe(0);
      expect(csv.stdout.trim().split("\n")).toEqual([
        "exchange,symbol,baseAsset,value",
        "bybit,BTCUSDT,BTC,0.00012",
        "okx,BTC-USDT-SWAP,BTC,0.0001",
      ]);
      expect(seen[0]).toContain("metric=fundingRate");
      expect(seen[0]).toContain("baseAsset=BTC");
      expect(seen[0]).toContain("contractType=perpetual");
      expect(seen[0]).toContain("limit=2");

      const table = await cli(["futures", "top", "-m", "fundingRate", ...keyed(base), "--output", "table"]);
      expect(table.stdout.split("\n")[0]).toBe("fundingRate  1h bucket  ts 2026-10-28T00:00:00.000Z  desc");
    });
  });

  it("futures liquidations: events as rows, lower-bound note from the catalog on stderr", async () => {
    const body = {
      from: 1793142000000,
      to: 1793145600000,
      events: [
        { ts: 1793145500000, exchange: "binance", symbol: "ETHUSDT", side: "long", price: 3000, quantity: 2, notional: 6000 },
        { ts: 1793145400000, exchange: "bybit", symbol: "BTCUSDT", side: "short", price: 100000, quantity: 0.1, notional: 10000 },
      ],
      truncated: true,
    };
    await withFuturesStub({ "/v1/futures/liquidations": { body } }, async (base) => {
      const csv = await cli(["futures", "liquidations", "--side", "long", ...keyed(base), "--output", "csv"]);
      expect(csv.code).toBe(0);
      const lines = csv.stdout.trim().split("\n");
      expect(lines[0]).toBe("ts,exchange,symbol,side,price,quantity,notional");
      expect(lines[1]).toBe("2026-10-27T23:58:20.000Z,binance,ETHUSDT,long,3000,2,6000");
      expect(csv.stderr).toContain("these are the newest");
      expect(csv.stderr).toContain("note: binance throttles its public liquidation feed, so in a cascade its events are a lower bound.");
      expect(csv.stderr).not.toContain("bybit");
    });
  });

  it("futures liquidations below Max: non-zero exit carrying the 403 and the upgrade URL", async () => {
    const body = {
      statusCode: 403,
      message: "Liquidation events are not included in the pro plan. Upgrade at https://blackforge.so/pricing for the liquidation feed.",
    };
    await withFuturesStub({ "/v1/futures/liquidations": { status: 403, body } }, async (base) => {
      const { code, stderr } = await cli(["futures", "liquidations", ...keyed(base)]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("[403]");
      expect(stderr).toContain("https://blackforge.so/pricing");
    });
  });

  it("futures symbols: one contract per row", async () => {
    await withFuturesStub({ "/v1/futures/symbols": { body: ["BTC-USDT-SWAP", "ETH-USDT-SWAP"] } }, async (base, seen) => {
      const csv = await cli(["futures", "symbols", "-e", "okx", ...keyed(base), "--output", "csv"]);
      expect(csv.stdout.trim().split("\n")).toEqual(["symbol", "BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
      expect(seen[0]).toContain("/v1/futures/symbols?exchange=okx");
    });
  });

  it("catalog/metrics/venues --futures show the futures block; internal columns stay out of the table", async () => {
    await withFuturesStub({}, async (base) => {
      const metrics = await cli(["metrics", "--futures", "--base-url", base, "--output", "csv"]);
      expect(metrics.code).toBe(0);
      expect(metrics.stdout.trim().split("\n")).toEqual([
        "key,label,family,unit,minPlan",
        "markPrice,Mark price,price,price,free",
        "fundingRate,Funding rate,funding,ratio,free",
        "liqLongCount,Long liquidations,liquidations,count,max",
      ]);

      const venues = await cli(["venues", "--futures", "--base-url", base, "--output", "csv"]);
      expect(venues.stdout.trim().split("\n")).toEqual([
        "venue,minPlan,liquidations",
        "binance,free,lower bound",
        "bybit,pro,complete",
        "mexc,free,none published",
      ]);

      const table = await cli(["catalog", "--futures", "--base-url", base, "--output", "table"]);
      expect(table.stdout).toContain("Futures venues: binance (free, liquidations: lower bound), bybit (pro, liquidations: complete), mexc (free)");
      expect(table.stdout).toContain("History: the last 60 days, rows from 2026-11-07");
      expect(table.stdout).toContain("Liquidation events: max plan and up");

      const json = await cli(["catalog", "--futures", "--base-url", base, "--output", "json"]);
      expect(JSON.parse(json.stdout)).toEqual(FUTURES_CATALOG.futures);
    });
  });

  it("spot catalog output is unchanged by the futures block (json is the raw payload, csv the spot metrics)", async () => {
    await withFuturesStub({}, async (base) => {
      const csv = await cli(["metrics", "--base-url", base, "--output", "csv"]);
      expect(csv.stdout.trim().split("\n")).toEqual([
        "key,label,family,unit,minPlan",
        "qualityFlags,Quality flags,quality,bitmask,free",
      ]);
      expect(csv.stderr).toBe("");
    });
  });

  it("--futures on an API without futures fails clearly", async () => {
    await withStubApi({}, async (base) => {
      const { code, stderr } = await cli(["metrics", "--futures", "--base-url", base]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("no futures catalog");
    });
  });
});

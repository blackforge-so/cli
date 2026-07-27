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
    ]) {
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

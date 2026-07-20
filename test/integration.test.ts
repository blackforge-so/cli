import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
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

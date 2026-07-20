import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BASE_URL,
  maskKey,
  readConfig,
  resolveConfig,
  writeConfig,
  configPathFor,
} from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bf-cli-cfg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("config resolution order", () => {
  it("defaults baseUrl and has no key when nothing is set", () => {
    const cfg = resolveConfig({ env: {}, configDir: dir });
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.baseUrlSource).toBe("default");
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.apiKeySource).toBeUndefined();
  });

  it("config file supplies key and baseUrl when no env/flag", () => {
    writeConfig({ apiKey: "bf_fromfile", baseUrl: "https://cfg.example" }, dir);
    const cfg = resolveConfig({ env: {}, configDir: dir });
    expect(cfg.apiKey).toBe("bf_fromfile");
    expect(cfg.apiKeySource).toBe("config");
    expect(cfg.baseUrl).toBe("https://cfg.example");
    expect(cfg.baseUrlSource).toBe("config");
  });

  it("env overrides config file", () => {
    writeConfig({ apiKey: "bf_fromfile", baseUrl: "https://cfg.example" }, dir);
    const cfg = resolveConfig({
      env: {
        BLACKFORGE_API_KEY: "bf_fromenv",
        BLACKFORGE_BASE_URL: "https://env.example",
      },
      configDir: dir,
    });
    expect(cfg.apiKey).toBe("bf_fromenv");
    expect(cfg.apiKeySource).toBe("env");
    expect(cfg.baseUrl).toBe("https://env.example");
    expect(cfg.baseUrlSource).toBe("env");
  });

  it("flag overrides env and config file", () => {
    writeConfig({ apiKey: "bf_fromfile" }, dir);
    const cfg = resolveConfig({
      flagApiKey: "bf_fromflag",
      flagBaseUrl: "https://flag.example",
      env: { BLACKFORGE_API_KEY: "bf_fromenv" },
      configDir: dir,
    });
    expect(cfg.apiKey).toBe("bf_fromflag");
    expect(cfg.apiKeySource).toBe("flag");
    expect(cfg.baseUrl).toBe("https://flag.example");
    expect(cfg.baseUrlSource).toBe("flag");
  });

  it("strips a trailing slash from baseUrl", () => {
    const cfg = resolveConfig({
      flagBaseUrl: "https://x.example/api/",
      env: {},
      configDir: dir,
    });
    expect(cfg.baseUrl).toBe("https://x.example/api");
  });
});

describe("config file persistence", () => {
  it("writes config.json with mode 600 and merges on update", () => {
    const path = writeConfig({ apiKey: "bf_one" }, dir);
    expect(path).toBe(configPathFor(dir));
    expect(existsSync(path)).toBe(true);
    // 0o777 mask -> 0o600
    expect(statSync(path).mode & 0o777).toBe(0o600);

    writeConfig({ baseUrl: "https://merged.example" }, dir);
    const stored = readConfig(dir);
    expect(stored.apiKey).toBe("bf_one"); // preserved across the second write
    expect(stored.baseUrl).toBe("https://merged.example");

    // Sanity: it is valid JSON on disk.
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });

  it("treats a missing config file as empty", () => {
    expect(readConfig(dir)).toEqual({});
  });
});

describe("maskKey", () => {
  it("masks a normal key showing only a prefix and last 4", () => {
    const masked = maskKey("bf_demoMaxKey_0000000000000000");
    expect(masked).toContain("bf_demo");
    expect(masked).toContain("0000");
    expect(masked).not.toContain("MaxKey_00000000");
    expect(masked).toContain("…");
  });
  it("handles a short key without leaking it whole", () => {
    expect(maskKey("bf_x")).toBe("bf_…");
  });
  it("returns (none) for an empty string", () => {
    expect(maskKey("")).toBe("(none)");
  });
});

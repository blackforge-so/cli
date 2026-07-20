import { homedir } from "node:os";
import { join } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

export const DEFAULT_BASE_URL = "https://api.blackforge.so";

export interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface ResolvedConfig {
  apiKey?: string;
  baseUrl: string;
  // Where each value came from — useful for `auth status`.
  apiKeySource?: "flag" | "env" | "config";
  baseUrlSource: "flag" | "env" | "config" | "default";
}

export interface ResolveInputs {
  flagApiKey?: string;
  flagBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
  configDir?: string; // override for tests
}

export function configDirFor(override?: string): string {
  return override ?? join(homedir(), ".blackforge");
}

export function configPathFor(override?: string): string {
  return join(configDirFor(override), "config.json");
}

export function readConfig(configDir?: string): StoredConfig {
  const path = configPathFor(configDir);
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as StoredConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A corrupt config file should not crash the CLI; treat it as empty.
    return {};
  }
}

// Persist config, creating ~/.blackforge with a private (0700) dir and a 0600 file
// so the API key is never world-readable.
export function writeConfig(next: StoredConfig, configDir?: string): string {
  const dir = configDirFor(configDir);
  const path = configPathFor(configDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const merged = { ...readConfig(configDir), ...next };
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync's mode only applies on create; enforce it unconditionally.
  chmodSync(path, 0o600);
  return path;
}

// Resolution order (highest first): flag -> env -> config file -> default.
export function resolveConfig(inputs: ResolveInputs = {}): ResolvedConfig {
  const env = inputs.env ?? process.env;
  const stored = readConfig(inputs.configDir);

  let apiKey: string | undefined;
  let apiKeySource: ResolvedConfig["apiKeySource"];
  if (inputs.flagApiKey) {
    apiKey = inputs.flagApiKey;
    apiKeySource = "flag";
  } else if (env.BLACKFORGE_API_KEY) {
    apiKey = env.BLACKFORGE_API_KEY;
    apiKeySource = "env";
  } else if (stored.apiKey) {
    apiKey = stored.apiKey;
    apiKeySource = "config";
  }

  let baseUrl: string;
  let baseUrlSource: ResolvedConfig["baseUrlSource"];
  if (inputs.flagBaseUrl) {
    baseUrl = inputs.flagBaseUrl;
    baseUrlSource = "flag";
  } else if (env.BLACKFORGE_BASE_URL) {
    baseUrl = env.BLACKFORGE_BASE_URL;
    baseUrlSource = "env";
  } else if (stored.baseUrl) {
    baseUrl = stored.baseUrl;
    baseUrlSource = "config";
  } else {
    baseUrl = DEFAULT_BASE_URL;
    baseUrlSource = "default";
  }

  // Normalize: strip a trailing slash so `${baseUrl}/v1/...` is always clean.
  baseUrl = baseUrl.replace(/\/+$/, "");

  return { apiKey, baseUrl, apiKeySource, baseUrlSource };
}

// bf_1234abcd... -> bf_1234…(last4)  — never print a full key.
export function maskKey(key: string): string {
  if (!key) return "(none)";
  if (key.length <= 10) return key.slice(0, 3) + "…";
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

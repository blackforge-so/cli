#!/usr/bin/env node
import { createInterface } from "node:readline";
import { Command, Option } from "commander";
import pc from "picocolors";
import { ApiError, BlackForgeClient } from "./client.js";
import {
  configPathFor,
  maskKey,
  resolveConfig,
  writeConfig,
} from "./config.js";
import {
  renderMetaFooter,
  renderRowSet,
  type RowSet,
} from "./render.js";
import type { ApiResult } from "./client.js";
import type { Catalog, OutputFormat } from "./types.js";

const VERSION = "0.1.0";
const KEYS_URL = "https://app.blackforge.so/keys";

interface GlobalOpts {
  output?: string;
  apiKey?: string;
  baseUrl?: string;
  verbose?: boolean;
}

// Resolve the output format: explicit flag wins, else table on a TTY, JSON otherwise
// (so `blackforge ... | jq` gets clean JSON without a flag).
function resolveFormat(opts: GlobalOpts): OutputFormat {
  if (opts.output) {
    if (!["table", "json", "csv"].includes(opts.output)) {
      fail(`Unknown --output "${opts.output}". Use table, json or csv.`);
    }
    return opts.output as OutputFormat;
  }
  return process.stdout.isTTY ? "table" : "json";
}

function makeClient(opts: GlobalOpts): {
  client: BlackForgeClient;
  baseUrl: string;
} {
  const cfg = resolveConfig({
    flagApiKey: opts.apiKey,
    flagBaseUrl: opts.baseUrl,
  });
  return {
    client: new BlackForgeClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }),
    baseUrl: cfg.baseUrl,
  };
}

// Print the payload in the chosen format, plus the metering footer on --verbose.
function emit(
  set: RowSet,
  format: OutputFormat,
  result: ApiResult<unknown>,
  opts: GlobalOpts,
  rawForJson?: unknown,
): void {
  process.stdout.write(renderRowSet(set, format, rawForJson) + "\n");
  if (opts.verbose) {
    const footer = renderMetaFooter(result.meta);
    if (footer) process.stderr.write(footer + "\n");
  }
}

function fail(message: string, code = 1): never {
  process.stderr.write(pc.red(`error: ${message}`) + "\n");
  process.exit(code);
}

// Any command handler runs through this so an ApiError becomes a clean stderr
// line + non-zero exit instead of an unhandled rejection / stack trace.
function run(fn: () => Promise<void>): void {
  fn().catch((err) => {
    if (err instanceof ApiError) {
      const status = err.status ? `[${err.status}] ` : "";
      fail(`${status}${err.serverMessage}`);
    }
    fail((err as Error).message ?? String(err));
  });
}

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const program = new Command();

program
  .name("blackforge")
  .description(
    "Terminal client for the BlackForge crypto market-data API — 9 spot venues, up to 117 columns per 5-minute window.",
  )
  .version(VERSION, "-V, --version")
  .addOption(
    new Option(
      "-o, --output <format>",
      "output format",
    ).choices(["table", "json", "csv"]),
  )
  .option("--api-key <key>", "API key (overrides env and config)")
  .option("--base-url <url>", "API base URL (overrides env and config)")
  .option("--verbose", "print the X-BlackForge-* metering footer to stderr")
  .showHelpAfterError();

function globals(command: Command): GlobalOpts {
  // Options are declared on the root program; merge with any the subcommand saw.
  return { ...program.opts(), ...command.opts() } as GlobalOpts;
}

// --- auth ------------------------------------------------------------------

program
  .command("login")
  .description("store an API key in ~/.blackforge/config.json (mode 600)")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      process.stdout.write(
        pc.bold("BlackForge login") +
          "\n" +
          pc.dim(`Get a key at ${KEYS_URL}`) +
          "\n",
      );
      const key = await readLine("API key (bf_...): ");
      if (!key) fail("No key entered.");
      const patch: { apiKey: string; baseUrl?: string } = { apiKey: key };
      if (opts.baseUrl) patch.baseUrl = opts.baseUrl;
      const path = writeConfig(patch);
      process.stdout.write(
        pc.green(`Saved ${maskKey(key)} to ${path}`) + "\n",
      );
    }),
  );

const auth = program
  .command("auth")
  .description("manage stored credentials");

auth
  .command("set-key <key>")
  .description("store an API key non-interactively")
  .action((key: string, _o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const patch: { apiKey: string; baseUrl?: string } = { apiKey: key };
      if (opts.baseUrl) patch.baseUrl = opts.baseUrl;
      const path = writeConfig(patch);
      process.stdout.write(
        pc.green(`Saved ${maskKey(key)} to ${path}`) + "\n",
      );
    }),
  );

auth
  .command("status")
  .description("show the resolved key (masked) + base URL and ping the API")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const cfg = resolveConfig({
        flagApiKey: opts.apiKey,
        flagBaseUrl: opts.baseUrl,
      });
      const lines: string[] = [];
      lines.push(
        `API key : ${cfg.apiKey ? maskKey(cfg.apiKey) : pc.dim("(none)")}` +
          (cfg.apiKeySource ? pc.dim(`  [${cfg.apiKeySource}]`) : ""),
      );
      lines.push(`Base URL: ${cfg.baseUrl}` + pc.dim(`  [${cfg.baseUrlSource}]`));
      lines.push(`Config  : ${configPathFor()}`);
      process.stdout.write(lines.join("\n") + "\n");

      // Keyless reachability ping via the catalog endpoint.
      const client = new BlackForgeClient({ baseUrl: cfg.baseUrl });
      try {
        const { data } = await client.catalog();
        process.stdout.write(
          pc.green(
            `Reachable: ${data.venues.length} venues, ${data.metrics.length} metrics.`,
          ) + "\n",
        );
      } catch (err) {
        const msg = err instanceof ApiError ? err.serverMessage : String(err);
        process.stdout.write(pc.yellow(`Unreachable: ${msg}`) + "\n");
      }
    }),
  );

// --- catalog / venues / metrics --------------------------------------------

program
  .command("catalog")
  .description("list venues and metric definitions (no key required)")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const result = await client.catalog();
      emitCatalog(result, format, opts);
    }),
  );

function emitCatalog(
  result: ApiResult<Catalog>,
  format: OutputFormat,
  opts: GlobalOpts,
): void {
  // For table/csv show a compact metric listing; JSON stays the raw payload.
  const set: RowSet = {
    columns: ["key", "label", "family", "unit", "minPlan"],
    rows: result.data.metrics.map((m) => ({
      key: m.key,
      label: m.label,
      family: m.family,
      unit: m.unit,
      minPlan: m.minPlan,
    })),
  };
  if (format === "table") {
    const venues = result.data.venues
      .map((v) => `${v.venue} (${v.minPlan})`)
      .join(", ");
    process.stdout.write(pc.bold("Venues: ") + venues + "\n\n");
  }
  emit(set, format, result, opts, result.data);
}

program
  .command("venues")
  .description("list venues only")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const result = await client.catalog();
      const set: RowSet = {
        columns: ["venue", "minPlan"],
        rows: result.data.venues.map((v) => ({ ...v })),
      };
      emit(set, format, result, opts, result.data.venues);
    }),
  );

program
  .command("metrics")
  .description("list metric definitions only")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const result = await client.catalog();
      const set: RowSet = {
        columns: ["key", "label", "family", "unit", "minPlan"],
        rows: result.data.metrics.map((m) => ({
          key: m.key,
          label: m.label,
          family: m.family,
          unit: m.unit,
          minPlan: m.minPlan,
        })),
      };
      emit(set, format, result, opts, result.data.metrics);
    }),
  );

// --- symbols ---------------------------------------------------------------

program
  .command("symbols")
  .description("list the symbols traded on a venue")
  .requiredOption("-e, --exchange <venue>", "venue, e.g. binance")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const local = command.opts<{ exchange: string }>();
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const result = await client.symbols(local.exchange);
      const set: RowSet = {
        columns: ["symbol"],
        rows: result.data.map((s) => ({ symbol: s })),
      };
      emit(set, format, result, opts, result.data);
    }),
  );

// --- latest ----------------------------------------------------------------

program
  .command("latest")
  .description("the most recent 5-minute bucket for a pair")
  .requiredOption("-e, --exchange <venue>", "venue, e.g. binance")
  .requiredOption("-s, --symbol <symbol>", "symbol, e.g. BTCUSDT")
  .option("-c, --columns <a,b,c>", "comma-separated metric keys to include")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const local = command.opts<{
        exchange: string;
        symbol: string;
        columns?: string;
      }>();
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const result = await client.latest(
        local.exchange,
        local.symbol,
        local.columns,
      );
      // Table/csv: one row per metric (key, value). JSON: raw {ts, values}.
      const set: RowSet = {
        columns: ["metric", "value"],
        rows: Object.entries(result.data.values).map(([metric, value]) => ({
          metric,
          value,
        })),
      };
      if (format === "table") {
        process.stdout.write(
          pc.dim(`ts ${new Date(result.data.ts).toISOString()}`) + "\n",
        );
      }
      emit(set, format, result, opts, result.data);
    }),
  );

// --- series ----------------------------------------------------------------

program
  .command("series")
  .description("a time series of one metric for a pair")
  .requiredOption("-e, --exchange <venue>", "venue, e.g. binance")
  .requiredOption("-s, --symbol <symbol>", "symbol, e.g. BTCUSDT")
  .requiredOption("-m, --metric <key>", "metric key, e.g. spreadMean")
  .addOption(
    new Option("-i, --interval <interval>", "bucket interval")
      .choices(["5m", "1h", "1d"])
      .default("5m"),
  )
  .option("--from <iso>", "start, ISO-8601 (e.g. 2026-07-01T00:00:00Z)")
  .option("--to <iso>", "end, ISO-8601")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const local = command.opts<{
        exchange: string;
        symbol: string;
        metric: string;
        interval: string;
        from?: string;
        to?: string;
      }>();
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const result = await client.series({
        exchange: local.exchange,
        symbol: local.symbol,
        metric: local.metric,
        interval: local.interval,
        from: local.from,
        to: local.to,
      });
      const set: RowSet = {
        columns: ["ts", "value"],
        rows: result.data.points.map((p) => ({
          ts: new Date(p.ts).toISOString(),
          value: p.value,
        })),
      };
      // An unentitled column returns empty points + a Columns-Omitted header;
      // surface that so the emptiness is explained, not silent.
      if (
        !result.data.points.length &&
        result.meta.columnsOmitted !== undefined
      ) {
        process.stderr.write(
          pc.yellow(
            `note: "${local.metric}" is not in your plan (columns omitted: ${result.meta.columnsOmitted}). Upgrade at https://blackforge.so/pricing`,
          ) + "\n",
        );
      }
      emit(set, format, result, opts, result.data);
    }),
  );

// --- usage -----------------------------------------------------------------

program
  .command("usage")
  .description("your recent request counts and remaining row quota")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const result = await client.usage();
      const set: RowSet = {
        columns: ["date", "count", "lastAt"],
        rows: result.data.days.map((d) => ({ ...d })),
      };
      if (format === "table" && result.data.rowsRemaining !== undefined) {
        process.stdout.write(
          pc.bold("Rows remaining: ") +
            result.data.rowsRemaining.toLocaleString("en-US") +
            "\n",
        );
      }
      emit(set, format, result, opts, result.data);
    }),
  );

program.parseAsync(process.argv).catch((err) => {
  fail((err as Error).message ?? String(err));
});

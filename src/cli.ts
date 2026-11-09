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
import {
  anyFlagged,
  anyQuality,
  bitsFromCatalog,
  formatSeriesNote,
  futuresBitsFromCatalog,
  isFlagged,
  latestQualityLine,
  qualityCell,
  summarizeSeriesQuality,
} from "./quality.js";
import type { ApiResult } from "./client.js";
import {
  INTERVALS,
  futuresSeriesAtPlanFloor,
  seriesAtPlanFloor,
} from "./interval.js";
import type {
  Catalog,
  FuturesCatalog,
  FuturesCatalogVenue,
  FuturesSeries,
  OutputFormat,
  QualityBit,
  Series,
} from "./types.js";

const VERSION = "0.3.0";
const KEYS_URL = "https://app.blackforge.so/api";

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

// The quality-flag decode table, read from the (keyless) catalog on demand and
// reused for the rest of the process. Never hardcode a copy of this table.
// If the fetch fails we fall back to raw masks rather than failing the command.
// `pick` chooses the spot table (default) or the futures one.
async function fetchQualityBits(
  opts: GlobalOpts,
  pick: (catalog: Catalog) => QualityBit[] = bitsFromCatalog,
): Promise<QualityBit[]> {
  try {
    const { client } = makeClient(opts);
    const { data } = await client.catalog();
    return pick(data);
  } catch {
    return [];
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
    "Terminal client for the BlackForge crypto market-data API: the major spot exchanges and their linear futures contracts, per minute on Ultra and PAYG and in coarser buckets otherwise (run `blackforge catalog` for the exact list, `blackforge catalog --futures` for futures).",
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
  .option("--futures", "the futures catalog instead: venues, columns, history")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const result = await client.catalog();
      if (command.opts<{ futures?: boolean }>().futures) {
        emitFuturesCatalog(result, format, opts);
        return;
      }
      emitCatalog(result, format, opts);
      // stderr, so a pipe never sees it; only where the API serves futures.
      if (format === "table" && result.data.futures) {
        process.stderr.write(
          pc.dim("Futures columns: blackforge catalog --futures") + "\n",
        );
      }
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

// --- futures catalog --------------------------------------------------------

function futuresCatalogOf(catalog: Catalog): FuturesCatalog {
  if (!catalog.futures) {
    fail("This API serves no futures catalog (no `futures` key in /v1/catalog).");
  }
  return catalog.futures;
}

function liquidationWord(v: FuturesCatalogVenue): string {
  if (v.liquidations === "complete") return "complete";
  if (v.liquidations === "lowerBound") return "lower bound";
  return "none published";
}

// Sold columns only: an internal column measures the recorder and belongs to
// no plan. JSON output still carries the raw payload, internal entries included.
function futuresMetricSet(fut: FuturesCatalog): RowSet {
  return {
    columns: ["key", "label", "family", "unit", "minPlan"],
    rows: fut.metrics
      .filter((m) => !m.internal)
      .map((m) => ({
        key: m.key,
        label: m.label,
        family: m.family,
        unit: m.unit,
        minPlan: m.minPlan,
      })),
  };
}

function emitFuturesCatalog(
  result: ApiResult<Catalog>,
  format: OutputFormat,
  opts: GlobalOpts,
): void {
  const fut = futuresCatalogOf(result.data);
  if (format === "table") {
    const venues = fut.venues
      .map((v) => {
        const liq = v.liquidations ? `, liquidations: ${liquidationWord(v)}` : "";
        return `${v.venue} (${v.minPlan}${liq})`;
      })
      .join(", ");
    process.stdout.write(pc.bold("Futures venues: ") + venues + "\n");
    if (fut.historyDays !== undefined || fut.availableFrom) {
      const days =
        fut.historyDays !== undefined ? `the last ${fut.historyDays} days` : "";
      const from = fut.availableFrom
        ? `rows from ${fut.availableFrom.slice(0, 10)}`
        : "";
      process.stdout.write(
        pc.bold("History: ") + [days, from].filter(Boolean).join(", ") + "\n",
      );
    }
    if (fut.liquidationEvents?.minPlan) {
      process.stdout.write(
        pc.bold("Liquidation events: ") +
          `${fut.liquidationEvents.minPlan} plan and up` +
          "\n",
      );
    }
    process.stdout.write("\n");
  }
  emit(futuresMetricSet(fut), format, result, opts, fut);
}

program
  .command("venues")
  .description("list venues only")
  .option("--futures", "the futures venues and their liquidation feeds")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const result = await client.catalog();
      if (command.opts<{ futures?: boolean }>().futures) {
        const fut = futuresCatalogOf(result.data);
        const set: RowSet = {
          columns: ["venue", "minPlan", "liquidations"],
          rows: fut.venues.map((v) => ({
            venue: v.venue,
            minPlan: v.minPlan,
            liquidations: liquidationWord(v),
          })),
        };
        emit(set, format, result, opts, fut.venues);
        return;
      }
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
  .option("--futures", "the futures column definitions")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const result = await client.catalog();
      if (command.opts<{ futures?: boolean }>().futures) {
        const fut = futuresCatalogOf(result.data);
        emit(futuresMetricSet(fut), format, result, opts, fut.metrics);
        return;
      }
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
  .description("the most recent closed bucket for a pair, at your plan's interval")
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
        // Quality is a header line, not a column: `latest` renders one row per
        // metric. Absent quality (today's API) prints nothing at all.
        const line = latestQualityLine(result.data.quality);
        if (line !== null) {
          const q = result.data.quality;
          const flagged = q !== undefined && isFlagged(q.raw);
          process.stdout.write(
            pc.dim("quality  ") + (flagged ? pc.yellow(line) : pc.dim(line)) + "\n",
          );
        }
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
    new Option(
      "-i, --interval <interval>",
      "bucket interval (default: your plan's finest, 1m on Ultra and PAYG, 5m otherwise)",
    ).choices([...INTERVALS]),
  )
  .option("--from <iso>", "start, ISO-8601 (e.g. 2026-07-01T00:00:00Z)")
  .option("--to <iso>", "end, ISO-8601")
  .option(
    "--quality",
    "add a per-bucket quality column (flag names, empty when clean)",
  )
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const local = command.opts<{
        exchange: string;
        symbol: string;
        metric: string;
        interval?: string;
        from?: string;
        to?: string;
        quality?: boolean;
      }>();
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const params = {
        exchange: local.exchange,
        symbol: local.symbol,
        metric: local.metric,
        from: local.from,
        to: local.to,
      };
      // No --interval: the plan's floor (src/interval.ts explains how it is found).
      let result: ApiResult<Series>;
      if (local.interval !== undefined) {
        result = await client.series({ ...params, interval: local.interval });
      } else {
        const picked = await seriesAtPlanFloor(client, params);
        result = picked.result;
        if (picked.note) process.stderr.write(pc.dim(picked.note) + "\n");
      }
      const points = result.data.points;
      if (result.data.truncated) {
        process.stderr.write(
          pc.yellow(
            `note: the range holds more than ${points.length.toLocaleString("en-US")} buckets; these are the newest. Narrow --from/--to or use a coarser --interval for the rest.`,
          ) + "\n",
        );
      }

      // The decode table is only worth a round-trip when there is something to
      // decode. `--quality` needs it for the column; otherwise only a real flag
      // (not the "never assessed" sentinel) justifies the fetch.
      const needBits = local.quality ? anyQuality(points) : anyFlagged(points);
      const bits = needBits ? await fetchQualityBits(opts) : [];

      // Default columns are untouched: adding one would break every existing
      // CSV consumer. `--quality` is the opt-in.
      const set: RowSet = {
        columns: local.quality ? ["ts", "value", "quality"] : ["ts", "value"],
        rows: points.map((p) => ({
          ts: new Date(p.ts).toISOString(),
          value: p.value,
          ...(local.quality ? { quality: qualityCell(p.quality, bits) } : {}),
        })),
      };

      // One aggregate note on stderr, so a pipe is never polluted. Buckets that
      // simply predate the quality rail are not "flagged" and stay silent.
      const summary = summarizeSeriesQuality(points, bits);
      if (summary) {
        process.stderr.write(
          pc.yellow(formatSeriesNote(summary, !local.quality)) + "\n",
        );
      }

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

// --- futures ---------------------------------------------------------------
// Linear futures contracts (perpetual and dated) under /v1/futures/*. Same
// key, meter, output formats and error handling as the spot commands; the
// differences are the venue-native contract symbols and the futures catalog
// (`blackforge catalog --futures`), which carries its own quality-bit table.

const futures = program
  .command("futures")
  .description(
    "linear futures contracts: prices, funding, open interest, taker flow and liquidations (column list: blackforge metrics --futures)",
  );

function isoOrRaw(value: number | string | undefined): string {
  if (typeof value === "number") return new Date(value).toISOString();
  return value ?? "";
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

futures
  .command("symbols")
  .description("list the contracts a futures venue lists, as the venue spells them")
  .requiredOption("-e, --exchange <venue>", "futures venue, e.g. okx")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const local = command.opts<{ exchange: string }>();
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const result = await client.futuresSymbols(local.exchange);
      const set: RowSet = {
        columns: ["symbol"],
        rows: result.data.map((s) => ({ symbol: s })),
      };
      emit(set, format, result, opts, result.data);
    }),
  );

futures
  .command("latest")
  .description("the most recent complete bucket for a contract, at your plan's interval")
  .requiredOption("-e, --exchange <venue>", "futures venue, e.g. binance")
  .requiredOption(
    "-s, --symbol <contract>",
    "contract as the venue spells it, e.g. BTCUSDT (okx BTC-USDT-SWAP, gate BTC_USDT)",
  )
  .option("-c, --columns <a,b,c>", "comma-separated futures column keys to include")
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
      const result = await client.futuresLatest(
        local.exchange,
        local.symbol,
        local.columns,
      );
      const set: RowSet = {
        columns: ["metric", "value"],
        rows: Object.entries(result.data.values).map(([metric, value]) => ({
          metric,
          value,
        })),
      };
      if (format === "table") {
        const interval = result.data.interval ? `  (${result.data.interval} bucket)` : "";
        process.stdout.write(
          pc.dim(
            result.data.ts
              ? `ts ${new Date(result.data.ts).toISOString()}${interval}`
              : "no row for this contract",
          ) + "\n",
        );
        const line = latestQualityLine(result.data.quality);
        if (line !== null) {
          const q = result.data.quality;
          const flagged = q !== undefined && isFlagged(q.raw);
          process.stdout.write(
            pc.dim("quality  ") + (flagged ? pc.yellow(line) : pc.dim(line)) + "\n",
          );
        }
      }
      emit(set, format, result, opts, result.data);
    }),
  );

futures
  .command("series")
  .description("a time series of one futures column for a contract")
  .requiredOption("-e, --exchange <venue>", "futures venue, e.g. bybit")
  .requiredOption("-s, --symbol <contract>", "contract as the venue spells it, e.g. BTCUSDT")
  .requiredOption("-m, --metric <key>", "futures column key, e.g. fundingRate, openInterestValue")
  .addOption(
    new Option(
      "-i, --interval <interval>",
      "bucket interval (default: your plan's finest)",
    ).choices([...INTERVALS]),
  )
  .option("--from <iso>", "start, ISO-8601 (e.g. 2026-11-08T00:00:00Z)")
  .option("--to <iso>", "end, ISO-8601")
  .option(
    "--quality",
    "add a per-bucket quality column (flag names, empty when clean)",
  )
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const local = command.opts<{
        exchange: string;
        symbol: string;
        metric: string;
        interval?: string;
        from?: string;
        to?: string;
        quality?: boolean;
      }>();
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const params = {
        exchange: local.exchange,
        symbol: local.symbol,
        metric: local.metric,
        from: local.from,
        to: local.to,
      };
      let result: ApiResult<FuturesSeries>;
      if (local.interval !== undefined) {
        result = await client.futuresSeries({ ...params, interval: local.interval });
      } else {
        result = (await futuresSeriesAtPlanFloor(client, params)).result;
      }
      const points = result.data.points;
      if (result.data.truncated) {
        process.stderr.write(
          pc.yellow(
            `note: the range holds more than ${points.length.toLocaleString("en-US")} buckets; these are the newest. Narrow --from/--to or use a coarser --interval for the rest.`,
          ) + "\n",
        );
      }

      const needBits = local.quality ? anyQuality(points) : anyFlagged(points);
      const bits = needBits ? await fetchQualityBits(opts, futuresBitsFromCatalog) : [];

      const set: RowSet = {
        columns: local.quality ? ["ts", "value", "quality"] : ["ts", "value"],
        rows: points.map((p) => ({
          ts: new Date(p.ts).toISOString(),
          value: p.value,
          ...(local.quality ? { quality: qualityCell(p.quality, bits) } : {}),
        })),
      };

      const summary = summarizeSeriesQuality(points, bits);
      if (summary) {
        process.stderr.write(
          pc.yellow(formatSeriesNote(summary, !local.quality)) + "\n",
        );
      }
      if (!points.length && result.meta.columnsOmitted !== undefined) {
        process.stderr.write(
          pc.yellow(
            `note: "${local.metric}" is not in your plan (columns omitted: ${result.meta.columnsOmitted}). Upgrade at https://blackforge.so/pricing`,
          ) + "\n",
        );
      }
      emit(set, format, result, opts, result.data);
    }),
  );

futures
  .command("top")
  .description(
    "rank contracts by one column on the latest complete bucket, on one venue or every venue your plan has",
  )
  .requiredOption("-m, --metric <key>", "futures column key, e.g. fundingRate, openInterestValue")
  .option("-e, --exchange <venue>", "one venue (default: every futures venue your plan has)")
  .option("-b, --base-asset <coin>", "one coin across venues, e.g. BTC")
  .addOption(
    new Option("--contract-type <type>", "perpetual or dated").choices([
      "perpetual",
      "dated",
    ]),
  )
  .addOption(
    new Option("--order <order>", "desc (largest first, the default) or asc").choices([
      "desc",
      "asc",
    ]),
  )
  .option("-n, --limit <n>", "how many contracts, at most 100 (default 50)")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const local = command.opts<{
        metric: string;
        exchange?: string;
        baseAsset?: string;
        contractType?: string;
        order?: string;
        limit?: string;
      }>();
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const result = await client.futuresTop(local);
      const set: RowSet = {
        columns: ["exchange", "symbol", "baseAsset", "value"],
        rows: result.data.rows.map((r) => ({
          exchange: r.exchange,
          symbol: r.symbol,
          baseAsset: r.baseAsset,
          value: r.value,
        })),
      };
      if (format === "table") {
        const parts = [result.data.metric];
        if (result.data.interval) parts.push(`${result.data.interval} bucket`);
        if (result.data.ts) parts.push(`ts ${new Date(result.data.ts).toISOString()}`);
        if (result.data.order) parts.push(result.data.order);
        process.stdout.write(pc.dim(parts.join("  ")) + "\n");
      }
      emit(set, format, result, opts, result.data);
    }),
  );

futures
  .command("liquidations")
  .description(
    "liquidation events, newest first, on the venues that publish them (Max plan and up)",
  )
  .option("-e, --exchange <venue>", "one venue (default: every venue with a feed)")
  .option("-s, --symbol <contract>", "one contract, as the venue spells it")
  .addOption(
    new Option("--side <side>", "the position liquidated: long or short").choices([
      "long",
      "short",
    ]),
  )
  .option("--from <iso>", "start, ISO-8601 (default: one hour ago)")
  .option("--to <iso>", "end, ISO-8601 (default: now)")
  .option("-n, --limit <n>", "how many events, at most 1000 (default 100)")
  .action((_o, command: Command) =>
    run(async () => {
      const opts = globals(command);
      const local = command.opts<{
        exchange?: string;
        symbol?: string;
        side?: string;
        from?: string;
        to?: string;
        limit?: string;
      }>();
      const format = resolveFormat(opts);
      const { client } = makeClient(opts);
      const result = await client.futuresLiquidations(local);
      const events = result.data.events;
      const set: RowSet = {
        columns: ["ts", "exchange", "symbol", "side", "price", "quantity", "notional"],
        rows: events.map((e) => ({
          ts: new Date(e.ts).toISOString(),
          exchange: e.exchange,
          symbol: e.symbol,
          side: e.side,
          price: e.price,
          quantity: e.quantity,
          notional: e.notional,
        })),
      };
      if (format === "table") {
        process.stdout.write(
          pc.dim(`from ${isoOrRaw(result.data.from)}  to ${isoOrRaw(result.data.to)}`) + "\n",
        );
      }
      if (result.data.truncated) {
        process.stderr.write(
          pc.yellow(
            `note: the window holds more than ${events.length.toLocaleString("en-US")} events; these are the newest. Narrow --from/--to or raise --limit (at most 1000).`,
          ) + "\n",
        );
      }
      // Which feeds are throttled comes from the catalog, never a local list.
      if (events.length) {
        try {
          const { data } = await client.catalog();
          const throttled = (data.futures?.venues ?? [])
            .filter((v) => v.liquidations === "lowerBound")
            .map((v) => v.venue)
            .filter((venue) => events.some((e) => e.exchange === venue));
          if (throttled.length) {
            const verb =
              throttled.length === 1
                ? "throttles its public liquidation feed, so in a cascade its events are"
                : "throttle their public liquidation feeds, so in a cascade their events are";
            process.stderr.write(
              pc.dim(`note: ${joinWords(throttled)} ${verb} a lower bound.`) + "\n",
            );
          }
        } catch {
          // The note is a courtesy; the events stand on their own.
        }
      }
      emit(set, format, result, opts, result.data);
    }),
  );

program.parseAsync(process.argv).catch((err) => {
  fail((err as Error).message ?? String(err));
});

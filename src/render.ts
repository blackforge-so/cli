import Table from "cli-table3";
import pc from "picocolors";
import type { OutputFormat, ResponseMeta } from "./types.js";

// A generic row set: an ordered column list plus row objects keyed by column.
export interface RowSet {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// --- JSON -----------------------------------------------------------------

export function renderJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// --- CSV ------------------------------------------------------------------

function csvField(value: unknown): string {
  const s = cell(value);
  // Quote if the field contains a comma, quote, CR or LF; double embedded quotes.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function renderCsv(set: RowSet): string {
  const header = set.columns.map(csvField).join(",");
  const lines = set.rows.map((row) =>
    set.columns.map((c) => csvField(row[c])).join(","),
  );
  return [header, ...lines].join("\n");
}

// --- Table ----------------------------------------------------------------

export function renderTable(set: RowSet): string {
  const table = new Table({
    head: set.columns.map((c) => pc.bold(pc.cyan(c))),
    style: { head: [], border: [] },
  });
  for (const row of set.rows) {
    table.push(set.columns.map((c) => cell(row[c])));
  }
  return table.toString();
}

// Dispatch a RowSet to the chosen format. `rawForJson` lets JSON output be the
// exact API payload (pipeable) rather than the flattened row set.
export function renderRowSet(
  set: RowSet,
  format: OutputFormat,
  rawForJson?: unknown,
): string {
  switch (format) {
    case "json":
      return renderJson(rawForJson !== undefined ? rawForJson : set.rows);
    case "csv":
      return renderCsv(set);
    case "table":
    default:
      return set.rows.length ? renderTable(set) : pc.dim("(no rows)");
  }
}

// --- Metering footer ------------------------------------------------------

// Human-readable one-liner of the X-BlackForge-* headers, for --verbose (stderr).
export function renderMetaFooter(meta: ResponseMeta): string | null {
  const parts: string[] = [];
  if (meta.rowsServed !== undefined) parts.push(`rows served ${meta.rowsServed}`);
  if (meta.rowsRemaining !== undefined)
    parts.push(`rows remaining ${meta.rowsRemaining}`);
  if (meta.columnsOmitted !== undefined)
    parts.push(`columns omitted ${meta.columnsOmitted}`);
  if (meta.blocksBilled !== undefined)
    parts.push(`blocks billed ${meta.blocksBilled}`);
  if (!parts.length) return null;
  return pc.dim(`— ${parts.join(" · ")}`);
}

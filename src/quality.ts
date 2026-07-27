// The data-quality surface: decoding, one-line summaries, per-bucket cells.
//
// Two rules govern everything in here:
//
//  1. QUALITY IS OPTIONAL. The API does not serve it yet. When it is absent
//     every function here returns null/"" and the CLI prints NOTHING — output
//     against today's production is byte-for-byte what it always was.
//  2. NO LOCAL BIT TABLE. Flag names come from the catalog (`bits` on the
//     `qualityFlags` metric) or not at all; unnamed bits fall back to their raw
//     mask. A hardcoded mirror of that table has already cost this programme a
//     production incident.

import type { Catalog, Quality, QualityBit } from "./types.js";

/**
 * The ClickHouse column DEFAULT: "this row predates the quality rail", NOT
 * "this row is bad". The whole historical archive reads this value, so it is
 * reported with the neutral word "unknown" and never as a warning. A single
 * contract sentinel, not a decode table.
 */
export const QUALITY_UNKNOWN = 32768;

const REAL_FLAG_MASK = ~QUALITY_UNKNOWN;

/** True when the mask carries an actual quality flag (unknown alone does not). */
export function isFlagged(mask: number): boolean {
  return (mask & REAL_FLAG_MASK) !== 0;
}

/** True when the row was simply never assessed. */
export function isUnassessed(mask: number): boolean {
  return mask === QUALITY_UNKNOWN;
}

/** Pull the decode table off a catalog payload, if the API serves one. */
export function bitsFromCatalog(catalog: Catalog): QualityBit[] {
  return catalog.metrics.find((m) => m.key === "qualityFlags")?.bits ?? [];
}

/**
 * Decode a mask into flag names using the catalog table. Bits the table does
 * not name fall back to their raw mask; the unknown sentinel bit is skipped,
 * since callers report it separately and neutrally.
 */
export function decodeMask(mask: number, bits: QualityBit[]): string[] {
  const byMask = new Map<number, string>();
  for (const b of bits) {
    const m = b.mask ?? (b.bit !== undefined ? 1 << b.bit : undefined);
    const name = b.name ?? b.label;
    if (m !== undefined && name) byMask.set(m, name);
  }
  const out: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    const bitMask = 1 << i;
    if (bitMask === QUALITY_UNKNOWN) continue;
    if ((mask & bitMask) === 0) continue;
    out.push(byMask.get(bitMask) ?? `mask ${bitMask}`);
  }
  return out;
}

/**
 * The `latest` header line, minus its label. null when the API sent no quality
 * at all — the caller must then print nothing.
 */
export function latestQualityLine(quality: Quality | undefined): string | null {
  if (!quality || typeof quality.raw !== "number") return null;
  if (quality.raw === 0) return "ok";
  if (isUnassessed(quality.raw)) return "unknown (row predates the quality rail)";
  const names = quality.flags?.length ? quality.flags : [`mask ${quality.raw}`];
  const affected = quality.contaminates ?? [];
  return names.join(", ") + (affected.length ? ` — affects ${affected.join(", ")}` : "");
}

export interface QualitySummary {
  flaggedBuckets: number;
  of: number;
  /** Flag name → how many buckets carry it. */
  flags: Record<string, number>;
  /** Buckets that predate the quality rail. Never counted as flagged. */
  unassessedBuckets: number;
}

/** Aggregate the per-point quality integers. null when no bucket is flagged. */
export function summarizeSeriesQuality(
  points: Array<{ quality?: number }>,
  bits: QualityBit[],
): QualitySummary | null {
  let flaggedBuckets = 0;
  let unassessedBuckets = 0;
  const flags: Record<string, number> = {};
  for (const p of points) {
    const mask = p.quality;
    if (typeof mask !== "number" || mask === 0) continue;
    if (isUnassessed(mask)) {
      unassessedBuckets += 1;
      continue;
    }
    if (!isFlagged(mask)) continue;
    flaggedBuckets += 1;
    for (const name of decodeMask(mask, bits)) {
      flags[name] = (flags[name] ?? 0) + 1;
    }
  }
  if (!flaggedBuckets) return null;
  return { flaggedBuckets, of: points.length, flags, unassessedBuckets };
}

/**
 * The one-line stderr note. Never touches stdout, so a pipe stays clean.
 * `withColumnHint` is dropped once the caller already passed --quality.
 */
export function formatSeriesNote(summary: QualitySummary, withColumnHint: boolean): string {
  const flags = Object.entries(summary.flags)
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");
  const hint = withColumnHint ? " Re-run with --quality for a per-bucket column." : "";
  return `note: ${summary.flaggedBuckets} of ${summary.of} buckets flagged — ${flags}.${hint}`;
}

/** The opt-in per-bucket `quality` cell. Empty string when the bucket is clean. */
export function qualityCell(mask: number | undefined, bits: QualityBit[]): string {
  if (typeof mask !== "number" || mask === 0) return "";
  if (isUnassessed(mask)) return "unknown";
  return decodeMask(mask, bits).join(", ");
}

/** True when at least one bucket carries a real flag — i.e. worth fetching the table. */
export function anyFlagged(points: Array<{ quality?: number }>): boolean {
  return points.some((p) => typeof p.quality === "number" && isFlagged(p.quality));
}

/** True when any bucket carries any quality integer at all (clean rows included). */
export function anyQuality(points: Array<{ quality?: number }>): boolean {
  return points.some((p) => typeof p.quality === "number");
}

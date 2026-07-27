// Response shapes for the BlackForge public /v1 API.
// These mirror the API contract exactly; the CLI is a thin HTTP client over it.

export type Plan = "free" | "pro" | "max" | "payg" | string;

export interface CatalogVenue {
  venue: string;
  minPlan: Plan;
}

/**
 * One entry of the quality-flag decode table. The API serves this table ONCE,
 * on the `qualityFlags` metric of /v1/catalog, as a `bits` array. The CLI reads
 * it from there and never carries a copy: a local mirror of this table has
 * already caused one production incident in this programme. Every field is
 * optional so a growing server-side shape cannot break the client.
 */
export interface QualityBit {
  /** Bit index, 0-15. */
  bit?: number;
  /** The bit's mask, i.e. 1 << bit. Either this or `bit` identifies the flag. */
  mask?: number;
  /** Machine name, e.g. BOOK_DESYNCED. */
  name?: string;
  label?: string;
  description?: string;
  contaminates?: string[];
}

export interface CatalogMetric {
  key: string;
  label: string;
  family: string;
  unit: string;
  quoteRelative: boolean;
  nullable: boolean;
  description: string;
  howToRead: string;
  minPlan: Plan;
  /** Only on the `qualityFlags` metric: the 16-bit decode table. */
  bits?: QualityBit[];
}

export interface Catalog {
  venues: CatalogVenue[];
  metrics: CatalogMetric[];
}

export type Symbols = string[];

/**
 * The per-row data-quality assessment that sits beside `values` on /v1/latest.
 *
 * STRICTLY OPTIONAL: the API does not serve it yet, so its absence is the
 * normal case and must render nothing at all. `flags` and `contaminates`
 * arrive already decoded as strings — the CLI prints them and interprets nothing.
 */
export interface Quality {
  /** Bitwise OR of the quality flags on the row. 0 = clean, 32768 = never assessed. */
  raw: number;
  /** Bitwise AND across the underlying windows. */
  all: number;
  flags?: string[];
  contaminates?: string[];
  observedAt?: number;
}

export interface Latest {
  ts: number; // epoch ms
  values: Record<string, number | null>;
  /** Optional: absent on every response until the quality rail ships. */
  quality?: Quality;
}

export interface SeriesPoint {
  ts: number; // epoch ms
  value: number | null;
  /** Bitwise OR of the quality flags over the native windows in this bucket. */
  quality?: number;
  /** Bitwise AND of the quality flags over the native windows in this bucket. */
  qualityAll?: number;
}

export interface Series {
  metric: string;
  exchange: string;
  symbol: string;
  points: SeriesPoint[];
}

export interface UsageDay {
  date: string;
  count: number;
  lastAt: string;
}

export interface Usage {
  days: UsageDay[];
  rowsRemaining?: number;
}

// The metering headers the API returns; surfaced in --verbose footer / to stderr.
export interface ResponseMeta {
  rowsServed?: string;
  rowsRemaining?: string;
  columnsOmitted?: string;
  blocksBilled?: string;
}

export type OutputFormat = "table" | "json" | "csv";

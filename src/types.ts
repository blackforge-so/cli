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
  /** Bit index, 0-30 (19 bits served today). */
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
  /** Linear futures contracts. Absent on an API that serves no futures. */
  futures?: FuturesCatalog;
}

// --- Futures ---------------------------------------------------------------
// Linear futures contracts (perpetual and dated), one row per contract per
// minute, served under /v1/futures/*. The catalog block is its own shape: the
// spot `metrics` array never carries a futures column.

export interface FuturesCatalogVenue {
  venue: string;
  minPlan: Plan;
  /** How complete the venue's public liquidation feed is; null when it publishes none. */
  liquidations?: "complete" | "lowerBound" | null;
}

export interface FuturesCatalogMetric {
  key: string;
  label: string;
  family: string;
  unit: string;
  nullable?: boolean;
  description?: string;
  /** How minute values roll up into 5m/1h/1d: last, sum, or (bitmask), none. */
  rollup?: string;
  plottable?: boolean;
  intervals?: string[];
  /** null on internal columns, which belong to no plan. */
  minPlan: Plan | null;
  /** Venues where this column is always null (the venue publishes no such value). */
  nullOn?: string[];
  /** Measures the recorder, not the market: catalogued, never sold. */
  internal?: boolean;
}

export interface FuturesCatalog {
  venues: FuturesCatalogVenue[];
  metrics: FuturesCatalogMetric[];
  /** The futures quality-flag decode table (its own bits, not the spot table). */
  qualityBits?: QualityBit[];
  liquidationEvents?: {
    minPlan: Plan;
    fields: Array<{ key: string; unit?: string; description?: string }>;
  };
  /** When the futures rows start (ISO). */
  availableFrom?: string | null;
  /** A futures retention cap in days, or null: kept like spot, the plan's history window applies. */
  historyDays?: number | null;
}

export interface FuturesLatest {
  ts: number; // epoch ms, 0 when the contract has no row
  interval?: string;
  /** Text columns (baseAsset, quoteAsset, contractType) are strings. */
  values: Record<string, number | string | null>;
  quality?: Quality;
}

export interface FuturesSeries extends Series {
  interval?: string;
}

export interface FuturesTopRow {
  exchange: string;
  symbol: string;
  baseAsset: string;
  value: number | null;
}

export interface FuturesTop {
  metric: string;
  interval?: string;
  ts: number; // epoch ms, end of the ranked bucket
  order?: "asc" | "desc" | string;
  rows: FuturesTopRow[];
}

export interface LiquidationEvent {
  ts: number; // epoch ms, venue time
  exchange: string;
  symbol: string;
  /** The POSITION liquidated: a long is closed by a forced sell. */
  side: "long" | "short" | string;
  price: number | null;
  quantity: number | null;
  notional: number | null;
}

export interface FuturesLiquidations {
  from: number | string;
  to: number | string;
  events: LiquidationEvent[];
  truncated?: boolean;
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
  /** True when the range held more buckets than one response carries; the newest are returned. */
  truncated?: boolean;
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

// Response shapes for the BlackForge public /v1 API.
// These mirror the API contract exactly; the CLI is a thin HTTP client over it.

export type Plan = "free" | "pro" | "max" | "payg" | string;

export interface CatalogVenue {
  venue: string;
  minPlan: Plan;
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
}

export interface Catalog {
  venues: CatalogVenue[];
  metrics: CatalogMetric[];
}

export type Symbols = string[];

export interface Latest {
  ts: number; // epoch ms
  values: Record<string, number | null>;
}

export interface SeriesPoint {
  ts: number; // epoch ms
  value: number | null;
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

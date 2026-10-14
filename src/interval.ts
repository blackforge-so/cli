// Picking the series interval when the user did not pass --interval.
//
// The default is the key's plan floor: 1m for Ultra and PAYG, 5m for Max and
// below (1h/1d floors are handled the same way should a plan ever have one).
// The API does not tell a key its plan, so the floor is found the cheap way:
//
//   1. ask for 1m, the finest interval there is;
//   2. a plan whose floor is coarser answers 403 BEFORE any data is read or
//      metered ("The 1m interval is finer than the max plan's 5m granularity"),
//      and the floor is read off that message (5m when it cannot be parsed);
//   3. a 1m answer with no points (the minute rows only exist from the switch
//      to one-minute rows on, so any range before it is empty at 1m) is asked
//      again at 5m, which covers all history.
//
// An explicit --interval is never second-guessed: it goes to the API as typed.
import { ApiError } from "./client.js";
import type { ApiResult, BlackForgeClient } from "./client.js";
import type { Series } from "./types.js";

export const INTERVALS = ["1m", "5m", "1h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];

/** The plan floor named in a 403 "interval is finer than ..." message, else null. */
export function floorFromIntervalError(err: unknown): Interval | null {
  if (!(err instanceof ApiError) || err.status !== 403) return null;
  if (!/interval is finer than/i.test(err.serverMessage)) return null;
  const m = /plan's (1m|5m|1h|1d) granularity/i.exec(err.serverMessage);
  return (m?.[1] as Interval | undefined) ?? "5m";
}

export interface SeriesParams {
  exchange: string;
  symbol: string;
  metric: string;
  from?: string;
  to?: string;
}

export interface DefaultSeries {
  result: ApiResult<Series>;
  /** The interval that produced `result`. */
  interval: Interval;
  /** Why the interval differs from 1m, for one stderr note; null when 1m served. */
  note: string | null;
}

/** A series at the plan's floor (see the header). */
export async function seriesAtPlanFloor(
  client: BlackForgeClient,
  params: SeriesParams,
): Promise<DefaultSeries> {
  let first: ApiResult<Series>;
  try {
    first = await client.series({ ...params, interval: "1m" });
  } catch (err) {
    const floor = floorFromIntervalError(err);
    if (floor === null) throw err;
    const result = await client.series({ ...params, interval: floor });
    return { result, interval: floor, note: null };
  }
  // An unentitled column is empty at every interval: no point asking again.
  if (first.data.points.length > 0 || first.meta.columnsOmitted !== undefined) {
    return { result: first, interval: "1m", note: null };
  }
  const result = await client.series({ ...params, interval: "5m" });
  return {
    result,
    interval: "5m",
    note:
      result.data.points.length > 0
        ? "note: no one-minute rows in this range (they start at the switch to one-minute rows); showing 5m buckets. Pass --interval to choose."
        : null,
  };
}

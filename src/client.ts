import type {
  Catalog,
  Latest,
  ResponseMeta,
  Series,
  Symbols,
  Usage,
} from "./types.js";

// Thrown for any non-2xx API response. Carries the HTTP status and the server
// `message` so the CLI can print a clear line and exit non-zero.
export class ApiError extends Error {
  status: number;
  serverMessage: string;
  body: unknown;
  constructor(status: number, serverMessage: string, body?: unknown) {
    super(`HTTP ${status}: ${serverMessage}`);
    this.name = "ApiError";
    this.status = status;
    this.serverMessage = serverMessage;
    this.body = body;
  }
}

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch; // injectable for tests
}

export interface ApiResult<T> {
  data: T;
  meta: ResponseMeta;
}

function readMeta(headers: Headers): ResponseMeta {
  const meta: ResponseMeta = {};
  const served = headers.get("x-blackforge-rows-served");
  const remaining = headers.get("x-blackforge-rows-remaining");
  const omitted = headers.get("x-blackforge-columns-omitted");
  const billed = headers.get("x-blackforge-blocks-billed");
  if (served != null) meta.rowsServed = served;
  if (remaining != null) meta.rowsRemaining = remaining;
  if (omitted != null) meta.columnsOmitted = omitted;
  if (billed != null) meta.blocksBilled = billed;
  return meta;
}

export class BlackForgeClient {
  private baseUrl: string;
  private apiKey?: string;
  private fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    path: string,
    query: Record<string, string | undefined> = {},
    { requireKey = true }: { requireKey?: boolean } = {},
  ): Promise<ApiResult<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (requireKey) {
      if (!this.apiKey) {
        throw new ApiError(
          401,
          "No API key. Run `blackforge login` or pass --api-key / set BLACKFORGE_API_KEY. Get a key at https://app.blackforge.so/keys",
        );
      }
      headers["x-api-key"] = this.apiKey;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { headers });
    } catch (err) {
      throw new ApiError(
        0,
        `Could not reach ${this.baseUrl} (${(err as Error).message}). Check --base-url / your connection.`,
      );
    }

    const meta = readMeta(res.headers);
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      let serverMessage = res.statusText || "Request failed";
      if (parsed && typeof parsed === "object") {
        const m = (parsed as Record<string, unknown>).message;
        if (m !== undefined && m !== null) serverMessage = String(m);
      } else if (typeof parsed === "string" && parsed) {
        serverMessage = parsed;
      }
      throw new ApiError(res.status, serverMessage, parsed);
    }

    return { data: parsed as T, meta };
  }

  // Keyless.
  catalog(): Promise<ApiResult<Catalog>> {
    return this.request<Catalog>("/v1/catalog", {}, { requireKey: false });
  }

  symbols(exchange: string): Promise<ApiResult<Symbols>> {
    return this.request<Symbols>("/v1/symbols", { exchange });
  }

  latest(
    exchange: string,
    symbol: string,
    columns?: string,
  ): Promise<ApiResult<Latest>> {
    return this.request<Latest>("/v1/latest", { exchange, symbol, columns });
  }

  series(params: {
    exchange: string;
    symbol: string;
    metric: string;
    interval?: string;
    from?: string;
    to?: string;
  }): Promise<ApiResult<Series>> {
    return this.request<Series>("/v1/series", {
      exchange: params.exchange,
      symbol: params.symbol,
      metric: params.metric,
      interval: params.interval,
      from: params.from,
      to: params.to,
    });
  }

  usage(): Promise<ApiResult<Usage>> {
    return this.request<Usage>("/v1/usage");
  }
}

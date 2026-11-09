# @blackforge-so/cli

A terminal client for the [BlackForge](https://blackforge.so) crypto **market-data** API.
Discover the catalog, list a venue's pairs, pull the latest bucket or a time series, and
check your usage, as a table, JSON or CSV, straight from your shell.

BlackForge is **real time crypto market data from the major spot exchanges** (`binance, bitget,
bybit, coinbase, gate, kraken, kucoin, mexc, okx`): 150+ metrics for 14,000+ pairs, per
`(exchange, symbol)` per closed bucket. Run `blackforge catalog` for the exact list. Every column
is a **measurement**, for example the median lifetime of a resting price level or taker
buy-vs-sell volume, not a trade call. The CLI is a thin HTTP wrapper over the same `/v1` API the dashboard and MCP
server use: one key, one meter, more surfaces.

## Install

Run it without installing:

```bash
npx -y @blackforge-so/cli catalog
```

Or install it globally so `blackforge` is on your PATH:

```bash
npm i -g @blackforge-so/cli
blackforge --help
```

Requires Node.js 20 or newer.

## Quickstart

```bash
# 1. Store your API key (get one at https://app.blackforge.so/api)
blackforge login

# 2. Pull the most recent 5-minute bucket for a pair
blackforge latest --exchange binance --symbol BTCUSDT

# 3. Confirm what you've used
blackforge usage
```

`catalog`, `venues`, and `metrics` need **no key** — try `blackforge catalog` before you
even have one.

## Pull a market slice to CSV in one line

```bash
blackforge series \
  --exchange binance --symbol BTCUSDT \
  --metric upDepth30 --interval 5m \
  --from 2026-07-01T00:00:00Z --to 2026-07-02T00:00:00Z \
  --output csv > btc-book-depth.csv
```

That writes one measurement's time series straight to a CSV you can open in a spreadsheet or
feed to `pandas`. Swap `--metric` for any key from `blackforge metrics`.

### Intervals

`--interval` is one of `1m`, `5m`, `1h`, `1d`. One-minute buckets are on Ultra and PAYG (PAYG
bills a 1m row at five times a 5m row); Max and below go down to `5m`. Without `--interval`
the CLI asks for `1m` and, if your plan stops at a coarser floor, retries at the floor the API
names; a range from before the one-minute rows existed is served at `5m`, with a note on
stderr. A response holds at most 50,000 buckets (about 34 days at 1m); a longer range returns
the newest buckets and the CLI says so on stderr.

## Futures

The same key reads the **linear futures contracts** (perpetual and dated) on the major
futures venues: mark, index, last and best bid and ask prices, funding rate and next funding
time, open interest, taker buy and sell flow, and liquidations, per contract in real time.
History is a rolling 60 days, from 7 November 2026. Contracts are spelled the way each venue
spells them (`BTCUSDT` on binance and bybit, `BTC-USDT-SWAP` on okx, `BTC_USDT` on gate,
`XBTUSDTM` on kucoin); `baseAsset` is the same coin on every venue.

```bash
# What is there: venues, columns, history window, which venues publish liquidations
blackforge catalog --futures

# The latest bucket for one contract
blackforge futures latest -e bybit -s BTCUSDT -c markPrice,indexPrice,fundingRate,openInterestValue

# Funding for one coin across every venue your plan has, highest first
blackforge futures top -m fundingRate -b BTC --contract-type perpetual

# Open interest over a day, to CSV
blackforge futures series -e okx -s BTC-USDT-SWAP -m openInterestValue -i 1h \
  --from 2026-11-08T00:00:00Z --to 2026-11-09T00:00:00Z --output csv > btc-oi.csv

# Liquidation events of the last hour, newest first (Max plan and up)
blackforge futures liquidations -e bybit --side long
```

Plans follow the spot ladder: Free reads binance, gate and mexc futures as daily bars over
the last 14 days; Pro adds every futures venue at `1h`; Max goes down to `5m` and adds the
liquidation columns and the liquidation event feed; Ultra and PAYG go down to `1m`.
`blackforge catalog --futures` is the source for which plan includes what.

Liquidation events come from each venue's public feed. Venues that throttle that feed
(binance and okx) give a lower bound in a cascade, and the CLI says so on stderr when such a
venue is in the result; venues that publish no feed read `null` in the liquidation columns.
Futures rows carry their own `qualityFlags` table (`QUOTE_MISSING`, `TRADES_PARTIAL` and so
on), decoded from the futures catalog the same way the spot flags are.

## Commands

| Command | What it does |
|---|---|
| `blackforge login` | Prompt for a key and store it (config file, mode `600`). |
| `blackforge auth set-key <key>` | Store a key non-interactively. |
| `blackforge auth status` | Show the resolved key (masked) + base URL, and ping the API. |
| `blackforge catalog` | List venues and metric definitions. **No key required.** |
| `blackforge venues` | Venues only. **No key required.** |
| `blackforge metrics` | Metric definitions only (`key`, `label`, `family`, `unit`, `minPlan`). **No key required.** |
| `blackforge symbols --exchange <v>` | List the pairs a venue trades. |
| `blackforge latest --exchange <v> --symbol <s> [--columns a,b,c]` | The latest closed bucket at your plan's interval (1 minute on Ultra and PAYG, 5 minutes otherwise). |
| `blackforge series --exchange <v> --symbol <s> --metric <k> [--interval 1m\|5m\|1h\|1d] [--from <iso>] [--to <iso>] [--quality]` | A time series of one metric. Without `--interval` it uses your plan's finest interval (see below). |
| `blackforge usage` | Your recent request counts and remaining row quota. |
| `blackforge catalog --futures` | The futures venues, columns, history window and liquidation feeds. `venues --futures` and `metrics --futures` show one part each. **No key required.** |
| `blackforge futures symbols --exchange <v>` | The contracts a futures venue lists, as the venue spells them. |
| `blackforge futures latest --exchange <v> --symbol <c> [--columns a,b,c]` | The latest complete bucket for one contract at your plan's interval. |
| `blackforge futures series --exchange <v> --symbol <c> --metric <k> [--interval 1m\|5m\|1h\|1d] [--from <iso>] [--to <iso>] [--quality]` | A time series of one futures column. Without `--interval` it uses your plan's finest. |
| `blackforge futures top --metric <k> [--exchange <v>] [--base-asset <coin>] [--contract-type perpetual\|dated] [--order desc\|asc] [--limit <n>]` | Contracts ranked by one column on the latest complete bucket, on one venue or every venue your plan has. |
| `blackforge futures liquidations [--exchange <v>] [--symbol <c>] [--side long\|short] [--from <iso>] [--to <iso>] [--limit <n>]` | Liquidation events, newest first; the last hour by default. `side` is the position liquidated. Max plan and up. |

### Global options

| Option | Meaning |
|---|---|
| `--output <table\|json\|csv>` | Output format. Defaults to `table` on a TTY, `json` when piped. |
| `--api-key <key>` | Override the stored/env key for this call. |
| `--base-url <url>` | Override the API base URL (defaults to `https://api.blackforge.so`). |
| `--verbose` | Print the `X-BlackForge-*` metering footer (rows served/remaining, columns omitted) to stderr. |

## Output formats

- **`table`** — a bordered grid, the default in an interactive terminal.
- **`json`** — the raw API payload, unmodified, so it pipes cleanly into `jq`:
  ```bash
  blackforge latest -e binance -s BTCUSDT --output json | jq '.values.upDepth30'
  ```
- **`csv`** — a header row plus one row per record, ready for a spreadsheet.

## Data quality

When the API reports a row's measurement quality, `latest` prints one extra header line in
`table` format:

```
quality  BOOK_DESYNCED, BOOK_CROSSED — affects bookMicro, bookWalls, orderLadders
```

`quality  ok` means the window is clean, and `quality  unknown (row predates the quality
rail)` means the row was never assessed — unknown, not bad. `--output json` carries the full
`quality` object verbatim.

For `series`, a one-line summary goes to **stderr** when any bucket is flagged (so a pipe
stays clean), and `--quality` adds a per-bucket `quality` column to `table` and `csv`:

```bash
blackforge series -e binance -s BTCUSDT -m upDepth30 --quality --output csv
# ts,value,quality
```

Without `--quality` the default columns are unchanged. Flag names come from the `bits` table
on the `qualityFlags` metric in `blackforge catalog`; unnamed bits print as their raw mask.

## Configuration & auth

Key and base URL resolve in this order (first match wins):

1. `--api-key` / `--base-url` flags
2. `BLACKFORGE_API_KEY` / `BLACKFORGE_BASE_URL` environment variables
3. `~/.blackforge/config.json` (written by `blackforge login`, mode `600`)
4. Base URL default: `https://api.blackforge.so`

Your key is only ever stored locally, in that `600`-permission file. It is never printed in
full — `auth status` shows a masked form.

## Exit codes & errors

Any API error exits non-zero and prints the HTTP status plus the server's message to stderr:

- `400` — an unknown metric or malformed datetime.
- `402` — the row quota is exhausted.
- `403` — the venue or interval isn't in your plan; the message carries an upgrade URL.

A `series` request for a column outside your plan returns **empty** `points` with an
`X-BlackForge-Columns-Omitted` header (not an error); the CLI prints a note explaining the
emptiness so it never looks like missing data.

## Where to get a key

Mint one at **[app.blackforge.so/api](https://app.blackforge.so/api)**. The same key works
across the CLI, the [MCP server](https://www.npmjs.com/package/@blackforge-so/mcp), and the REST
API — one meter across every surface.

## License

MIT

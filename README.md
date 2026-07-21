# @blackforge-so/cli

A terminal client for the [BlackForge](https://blackforge.so) crypto **market-data** API.
Discover the catalog, list a venue's pairs, pull the latest 5-minute bucket or a time
series, and check your usage — as a table, JSON, or CSV, straight from your shell.

BlackForge is raw market-data intelligence: **9 spot venues** (`binance, bitget, bybit,
coinbase, gate, kraken, kucoin, mexc, okx`), ~13,800 pairs, up to **117 columns** per
`(exchange, symbol)` per closed 5-minute window. Every column is a **measurement** — for
example, the median lifetime of a resting price level, or taker buy-vs-sell volume — not a
trade call. The CLI is a thin HTTP wrapper over the same `/v1` API the dashboard and MCP
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
# 1. Store your API key (get one at https://app.blackforge.so/keys)
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
| `blackforge latest --exchange <v> --symbol <s> [--columns a,b,c]` | The latest 5-minute bucket. |
| `blackforge series --exchange <v> --symbol <s> --metric <k> [--interval 5m\|1h\|1d] [--from <iso>] [--to <iso>]` | A time series of one metric. |
| `blackforge usage` | Your recent request counts and remaining row quota. |

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

Mint one at **[app.blackforge.so/keys](https://app.blackforge.so/keys)**. The same key works
across the CLI, the [MCP server](https://www.npmjs.com/package/@blackforge-so/mcp), and the REST
API — one meter across every surface.

## License

MIT

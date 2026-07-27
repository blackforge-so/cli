import { describe, it, expect } from "vitest";
import {
  renderCsv,
  renderJson,
  renderRowSet,
  renderMetaFooter,
  renderTable,
  type RowSet,
} from "../src/render.js";
import {
  anyFlagged,
  anyQuality,
  bitsFromCatalog,
  decodeMask,
  formatSeriesNote,
  latestQualityLine,
  qualityCell,
  summarizeSeriesQuality,
} from "../src/quality.js";
import type { Catalog, QualityBit } from "../src/types.js";

const set: RowSet = {
  columns: ["ts", "value"],
  rows: [
    { ts: "2026-07-01T00:00:00.000Z", value: 1872.562239 },
    { ts: "2026-07-01T00:05:00.000Z", value: null },
  ],
};

describe("renderCsv", () => {
  it("emits a header row followed by one line per row", () => {
    const csv = renderCsv(set);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("ts,value");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("2026-07-01T00:00:00.000Z,1872.562239");
    // null renders as an empty field.
    expect(lines[2]).toBe("2026-07-01T00:05:00.000Z,");
  });

  it("quotes and escapes fields containing commas or quotes", () => {
    const tricky: RowSet = {
      columns: ["label"],
      rows: [{ label: 'a,b "c"' }],
    };
    const csv = renderCsv(tricky);
    expect(csv.split("\n")[1]).toBe('"a,b ""c"""');
  });
});

describe("renderJson", () => {
  it("pretty-prints the raw payload verbatim", () => {
    const payload = { metric: "upDepth30", points: [{ ts: 1, value: 2 }] };
    const out = renderJson(payload);
    expect(JSON.parse(out)).toEqual(payload);
    expect(out).toContain("\n"); // indented, not single-line
  });
});

describe("renderRowSet", () => {
  it("json format returns the raw payload when provided, not the flattened rows", () => {
    const raw = { points: [{ ts: 1, value: 2 }] };
    expect(JSON.parse(renderRowSet(set, "json", raw))).toEqual(raw);
  });

  it("table format renders a bordered grid containing the values", () => {
    const out = renderRowSet(set, "table");
    expect(out).toContain("ts");
    expect(out).toContain("value");
    expect(out).toContain("1872.562239");
    expect(out).toContain("│"); // cli-table3 border glyph
  });

  it("table format on an empty set says (no rows)", () => {
    const empty: RowSet = { columns: ["x"], rows: [] };
    expect(renderRowSet(empty, "table")).toContain("(no rows)");
  });
});

describe("cell() on non-scalars", () => {
  const nested: RowSet = {
    columns: ["flags", "meta", "empty"],
    rows: [{ flags: ["A", "B"], meta: { raw: 6 }, empty: undefined }],
  };

  it("csv JSON-encodes objects and arrays, quoting the embedded commas/quotes", () => {
    const line = renderCsv(nested).split("\n")[1];
    // ["A","B"] contains commas AND quotes, so it is quoted with doubled quotes.
    expect(line).toBe('"[""A"",""B""]","{""raw"":6}",');
  });

  it("table renders objects and arrays as JSON, and undefined as empty", () => {
    const out = renderTable(nested);
    expect(out).toContain('["A","B"]');
    expect(out).toContain('{"raw":6}');
  });
});

// The decode table always comes from the catalog. These fixtures stand in for
// it; nothing in src/ may ever hardcode an equivalent.
const BITS: QualityBit[] = [
  { bit: 0, name: "BOOK_DESYNCED" },
  { bit: 1, name: "BOOK_CROSSED" },
  { bit: 11, name: "EVENTS_LOST" },
];

describe("quality decode", () => {
  it("reads the bit table off the qualityFlags catalog metric", () => {
    const catalog = {
      venues: [],
      metrics: [
        { key: "spreadMean" },
        { key: "qualityFlags", bits: BITS },
      ],
    } as unknown as Catalog;
    expect(bitsFromCatalog(catalog)).toEqual(BITS);
    expect(bitsFromCatalog({ venues: [], metrics: [] })).toEqual([]);
  });

  it("decodes named bits and falls back to raw masks for unnamed ones", () => {
    expect(decodeMask(3, BITS)).toEqual(["BOOK_DESYNCED", "BOOK_CROSSED"]);
    expect(decodeMask(4, BITS)).toEqual(["mask 4"]);
    expect(decodeMask(2049, [])).toEqual(["mask 1", "mask 2048"]);
  });

  it("never treats the 32768 sentinel as a flag", () => {
    expect(decodeMask(32768, BITS)).toEqual([]);
    expect(anyFlagged([{ quality: 32768 }])).toBe(false);
    expect(anyFlagged([{ quality: 1 }])).toBe(true);
    expect(anyQuality([{ quality: 0 }])).toBe(true);
    expect(anyQuality([{}])).toBe(false);
  });
});

describe("latestQualityLine", () => {
  it("returns null when the API sent no quality — the CLI then prints nothing", () => {
    expect(latestQualityLine(undefined)).toBeNull();
  });

  it("says ok on a clean row", () => {
    expect(latestQualityLine({ raw: 0, all: 0, flags: [], contaminates: [] })).toBe("ok");
  });

  it("says unknown, not a warning, on the 32768 sentinel", () => {
    expect(latestQualityLine({ raw: 32768, all: 32768 })).toBe(
      "unknown (row predates the quality rail)",
    );
  });

  it("names the flags and what they affect", () => {
    expect(
      latestQualityLine({
        raw: 6,
        all: 6,
        flags: ["BOOK_DESYNCED", "BOOK_CROSSED"],
        contaminates: ["bookMicro", "bookWalls", "orderLadders"],
      }),
    ).toBe("BOOK_DESYNCED, BOOK_CROSSED — affects bookMicro, bookWalls, orderLadders");
  });

  it("falls back to the raw mask when the server sent no decoded names", () => {
    expect(latestQualityLine({ raw: 6, all: 6 })).toBe("mask 6");
  });
});

describe("series quality summary", () => {
  const points = [
    { quality: 0 },
    { quality: 1 },
    { quality: 1 },
    { quality: 2048 },
    { quality: 32768 },
  ];

  it("counts flagged buckets per flag name, unknown buckets apart", () => {
    expect(summarizeSeriesQuality(points, BITS)).toEqual({
      flaggedBuckets: 3,
      of: 5,
      flags: { BOOK_DESYNCED: 2, EVENTS_LOST: 1 },
      unassessedBuckets: 1,
    });
  });

  it("is null when nothing is flagged, including an all-unknown archive", () => {
    expect(summarizeSeriesQuality([{ quality: 0 }], BITS)).toBeNull();
    expect(summarizeSeriesQuality([{ quality: 32768 }, { quality: 32768 }], BITS)).toBeNull();
    expect(summarizeSeriesQuality([{}, {}], BITS)).toBeNull();
  });

  it("formats the one-line stderr note", () => {
    const summary = {
      flaggedBuckets: 3,
      of: 288,
      flags: { BOOK_DESYNCED: 2, EVENTS_LOST: 1 },
      unassessedBuckets: 0,
    };
    expect(formatSeriesNote(summary, true)).toBe(
      "note: 3 of 288 buckets flagged — BOOK_DESYNCED (2), EVENTS_LOST (1). " +
        "Re-run with --quality for a per-bucket column.",
    );
    // --quality already on: no point suggesting it again.
    expect(formatSeriesNote(summary, false)).toBe(
      "note: 3 of 288 buckets flagged — BOOK_DESYNCED (2), EVENTS_LOST (1).",
    );
  });

  it("renders a per-bucket cell, empty when clean", () => {
    expect(qualityCell(0, BITS)).toBe("");
    expect(qualityCell(undefined, BITS)).toBe("");
    expect(qualityCell(2049, BITS)).toBe("BOOK_DESYNCED, EVENTS_LOST");
    expect(qualityCell(32768, BITS)).toBe("unknown");
  });
});

describe("renderMetaFooter", () => {
  it("summarizes the X-BlackForge-* headers", () => {
    const footer = renderMetaFooter({
      rowsServed: "13",
      rowsRemaining: "49999946",
      columnsOmitted: "2",
    });
    expect(footer).toContain("rows served 13");
    expect(footer).toContain("rows remaining 49999946");
    expect(footer).toContain("columns omitted 2");
  });

  it("returns null when there are no metering headers", () => {
    expect(renderMetaFooter({})).toBeNull();
  });
});

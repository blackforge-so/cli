import { describe, it, expect } from "vitest";
import {
  renderCsv,
  renderJson,
  renderRowSet,
  renderMetaFooter,
  type RowSet,
} from "../src/render.js";

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

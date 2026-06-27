/**
 * Parity tests mirroring the Python test_logic.py oracle, so the TS engine
 * provably matches the validated behavior against real toplo.bg strings.
 */
import { describe, it, expect } from "vitest";
import {
  stripNeighborhood,
  parseBlocks,
  parseStreets,
  isWholeNeighborhood,
  isPolygon,
  pointInPolygon,
  ringsFromGeojson,
  parseOutagesHtml,
  outagePhase,
  matchAddress,
  Tier,
  type Address,
  type Outage,
} from "./index";

const sorted = (s: Iterable<string>) => [...s].sort();

describe("text helpers", () => {
  it("strips neighborhood prefixes", () => {
    expect(stripNeighborhood("Part of Borovo")).toBe("Borovo");
    expect(stripNeighborhood("Част от Борово")).toBe("Борово");
    expect(stripNeighborhood("Zaharna fabrika")).toBe("Zaharna fabrika");
  });

  it("parses blocks (lists and chained)", () => {
    expect(sorted(parseBlocks("бл.206 вх. 8, 9, 10, бл.206А, бл.207А"))).toEqual(sorted(["206", "206А", "207А"]));
    expect(sorted(parseBlocks("Бл.14,15,16 и 17."))).toEqual(sorted(["14", "15", "16", "17"]));
    expect(sorted(parseBlocks("бл.40, 43, 44, 45, 55, 56, 57."))).toEqual(
      sorted(["40", "43", "44", "45", "55", "56", "57"]),
    );
  });

  it("parses streets with house numbers", () => {
    const streets = new Map(parseStreets('ул."Коста Лулчев" №27 ДЕО (ИЧС).'));
    expect(sorted(streets.get("коста лулчев") ?? new Set())).toEqual(["27"]);
  });

  it("detects whole-neighborhood and polygon phrasing", () => {
    expect(isWholeNeighborhood("the whole neighborhood")).toBe(true);
    expect(isWholeNeighborhood("целия квартал")).toBe(true);
    expect(isWholeNeighborhood("целият квартал")).toBe(true); // live inflection
    expect(isWholeNeighborhood('ул."Костур"')).toBe(false);
    expect(isPolygon('в участъка между бул."Гоце Делчев", ул."Ястребец"')).toBe(true);
  });
});

describe("matching scenarios", () => {
  it("Borovo polygon text vs Topli dol -> POSSIBLE", () => {
    const o: Outage = {
      neighborhood: "Borovo",
      areaText: 'в участъка: бул."Гоце Делчев", ул."Ястребец", ул."Борово", бул."България"',
    };
    const addr: Address = { label: "Topli dol", neighborhood: "Borovo", street: "Топли дол", houseNumber: "1а" };
    expect(matchAddress(addr, o)[0]).toBe(Tier.POSSIBLE);
  });

  it("different neighborhood -> CLEAR", () => {
    const addr: Address = { label: "Svishtov", neighborhood: "Banishora", street: "Свищов", houseNumber: "4" };
    const o: Outage = { neighborhood: "Center", areaText: "между бул. Патриарх Евтимий ..." };
    expect(matchAddress(addr, o)[0]).toBe(Tier.CLEAR);
  });

  it("whole neighborhood -> AFFECTED", () => {
    const o: Outage = { neighborhood: "Zaharna fabrika", areaText: "the whole neighborhood" };
    const addr: Address = { label: "ZF", neighborhood: "Zaharna fabrika", street: "x", houseNumber: "1" };
    expect(matchAddress(addr, o)[0]).toBe(Tier.AFFECTED);
  });

  it("block listed -> AFFECTED", () => {
    const o: Outage = { neighborhood: "Mladost 2", areaText: "бл.206 вх. 8, 9, 10, бл.206А, бл.207А" };
    const addr: Address = { label: "206A", neighborhood: "Mladost 2", block: "206А" };
    expect(matchAddress(addr, o)[0]).toBe(Tier.AFFECTED);
  });

  it("street + house number -> AFFECTED", () => {
    const o: Outage = { neighborhood: "Geo Milev", areaText: 'ул."Коста Лулчев" №27' };
    const addr: Address = { label: "KL27", neighborhood: "Geo Milev", street: "Коста Лулчев", houseNumber: "27" };
    expect(matchAddress(addr, o)[0]).toBe(Tier.AFFECTED);
  });
});

describe("geometry", () => {
  const square: Array<[number, number]> = [
    [23.264, 42.717],
    [23.266, 42.717],
    [23.266, 42.718],
    [23.264, 42.718],
    [23.264, 42.717],
  ];

  it("point-in-polygon", () => {
    expect(pointInPolygon(23.265, 42.7175, square)).toBe(true);
    expect(pointInPolygon(23.3, 42.7, square)).toBe(false);
    expect(pointInPolygon(0, 0, [[0, 0], [1, 1]] as Array<[number, number]>)).toBe(false);
  });

  it("parses GeoJSON rings", () => {
    const geo =
      '[{"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[23.264,42.717],[23.266,42.717],[23.266,42.718],[23.264,42.718],[23.264,42.717]]]}}]';
    const rings = ringsFromGeojson(geo);
    expect(rings.length).toBe(1);
    expect(rings[0][0]).toEqual([23.264, 42.717]);
    expect(ringsFromGeojson(null)).toEqual([]);
  });
});

describe("parseOutagesHtml + geometry match", () => {
  const geo =
    '[{"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[23.264,42.717],[23.266,42.717],[23.266,42.718],[23.264,42.718],[23.264,42.717]]]}}]';
  const info = {
    AccidentId: "abc",
    Name: "Част от Люлин 9",
    Addresses: "Бл.906,907.",
    GeolocationSerialized: geo,
    Type: 0,
    FromDate: "2026-06-26T14:00:00Z",
    UntilDate: "2026-06-26T20:00:00Z",
    Region: "Люлин 9",
  };
  // Mirror how the page embeds it: `var info = {…}` inside a script comment.
  const sample = `<script>(function parseAll(){ <!--\n var info = ${JSON.stringify(info)}\n if (x) {} --> })()</script>`;

  it("extracts one outage with geometry", () => {
    const outs = parseOutagesHtml(sample);
    expect(outs.length).toBe(1);
    expect(outs[0].neighborhood).toBe("Люлин 9");
    expect(outs[0].areaText).toBe("Бл.906,907.");
    expect(outs[0].start).toBe("2026-06-26T14:00:00Z");
    expect(outs[0].polygons?.length).toBe(1);
  });

  it("dedupes by AccidentId", () => {
    expect(parseOutagesHtml(sample + sample).length).toBe(1);
  });

  it("geometry decides AFFECTED vs CLEAR", () => {
    const [o] = parseOutagesHtml(sample);
    expect(matchAddress({ label: "in", neighborhood: "Люлин 9", lat: 42.7175, lng: 23.265 }, o)[0]).toBe(Tier.AFFECTED);
    expect(matchAddress({ label: "out", neighborhood: "Люлин 9", lat: 42.7, lng: 23.3 }, o)[0]).toBe(Tier.CLEAR);
  });

  it("falls back to text matcher without coords", () => {
    const [o] = parseOutagesHtml(sample);
    expect(matchAddress({ label: "906", neighborhood: "Люлин 9", block: "906" }, o)[0]).toBe(Tier.AFFECTED);
  });
});

describe("phase", () => {
  const NOW = new Date("2026-06-26T13:00:00Z");
  const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  const H = 3600_000;

  it("classifies active / upcoming / ended", () => {
    expect(outagePhase({ neighborhood: "X", areaText: "", start: iso(-2 * H), recovery: iso(2 * H) }, NOW)).toBe("active");
    expect(outagePhase({ neighborhood: "X", areaText: "", start: iso(5 * H), recovery: iso(9 * H) }, NOW)).toBe("upcoming");
    expect(outagePhase({ neighborhood: "X", areaText: "", start: iso(-48 * H), recovery: iso(-1 * H) }, NOW)).toBe("ended");
    expect(outagePhase({ neighborhood: "X", areaText: "" }, NOW)).toBe("active");
  });
});

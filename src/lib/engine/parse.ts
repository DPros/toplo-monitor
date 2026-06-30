/**
 * Parse the toplo.bg accidents page into Outages. The page embeds one
 * `var info = {…}` object per outage inside an inline <script> comment; the
 * object is JSON whose GelocationSerialized value is itself a JSON string
 * containing braces, so we consume exactly one balanced object (string-aware)
 * rather than regex-matching it. Mirrors Python's json.raw_decode approach.
 */
import type { Outage } from "./types";
import { stripNeighborhood } from "./text";
import { ringsFromGeojson } from "./geo";

/** Read one balanced JSON object starting at `start` (which must be '{'). */
function readJsonObject(s: string, start: number): unknown | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

interface RawInfo {
  AccidentId?: string;
  ContentItemId?: string;
  Name?: string;
  Region?: string;
  Addresses?: string;
  GeolocationSerialized?: string;
  Type?: number;
  FromDate?: string;
  UntilDate?: string;
}

export function parseOutagesHtml(html: string): Outage[] {
  const outages: Outage[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/var\s+info\s*=\s*/g)) {
    const braceIdx = (m.index ?? 0) + m[0].length;
    if (html[braceIdx] !== "{") continue;
    const parsed = readJsonObject(html, braceIdx);
    if (!parsed || typeof parsed !== "object") continue;
    const info = parsed as RawInfo;

    const ident = info.AccidentId || info.ContentItemId;
    if (ident && seen.has(ident)) continue;
    if (ident) seen.add(ident);

    // "Region" is the bare neighborhood ("Люлин 9"); "Name" prefixes "Част от".
    let neighborhood = (info.Region || "").trim();
    if (!neighborhood) neighborhood = stripNeighborhood((info.Name || "").trim());

    outages.push({
      accidentId: ident,
      neighborhood,
      areaText: (info.Addresses || "").trim(),
      kind: info.Type ? "repairs" : "accident",
      start: info.FromDate ?? null,
      recovery: info.UntilDate ?? null,
      polygons: ringsFromGeojson(info.GeolocationSerialized),
    });
  }
  return outages;
}

/**
 * Text normalization + the heuristic parsers (blocks, streets, whole-neighborhood
 * and "between streets" detection). Faithful port of the Python helpers; the
 * regexes use \p{L} (with the `u` flag) where Python relied on Unicode \w/\b,
 * since JS word boundaries are ASCII-only.
 */

/** Lowercase, NFKC-normalize, unify quotes, collapse whitespace. */
export function norm(s?: string | null): string {
  if (!s) return "";
  let r = s.normalize("NFKC");
  r = r.replace(/[„“”]/g, '"').replace(/’/g, "'");
  r = r.replace(/\s+/g, " ");
  return r.trim().toLowerCase();
}

const NEIGHBORHOOD_PREFIXES = ["Part of ", "Част от ", "part of ", "част от "];

/** 'Part of Borovo' / 'Част от Борово' -> 'Borovo' / 'Борово'. */
export function stripNeighborhood(header: string): string {
  const h = header.trim();
  for (const p of NEIGHBORHOOD_PREFIXES) {
    if (h.startsWith(p)) return h.slice(p.length).trim();
  }
  return h;
}

/** Extract block identifiers from 'бл.206, бл.206А' and chained 'Бл.14,15,16 и 17'. */
export function parseBlocks(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(/бл\.?\s*(\d+[А-Яа-я]?)/gi)) {
    found.add(m[1].replace(/\s+/g, "").toUpperCase());
  }
  // Numbers chained after the first 'бл.' such as 'бл.14,15,16 и 17'.
  const chained = text.match(/бл\.?\s*([\d\sА-Яа-я,и]+)/i);
  if (chained) {
    for (const raw of chained[1].split(/[,\s]+/)) {
      const tok = raw.trim();
      if (/^\d+[А-Яа-я]?$/.test(tok)) found.add(tok.toUpperCase());
    }
  }
  return found;
}

/**
 * Return [normalizedStreetName, {houseNumbers}] for each 'ул.'/'бул.' marker.
 * Each marker's segment runs up to the next marker, so chained lists and
 * trailing notes don't break parsing.
 */
export function parseStreets(text: string): Array<[string, Set<string>]> {
  const out: Array<[string, Set<string>]> = [];
  // 'бул' before 'ул' so the longer token wins; the look-around enforces a
  // word boundary (JS \b won't, for Cyrillic).
  const markers = [...text.matchAll(/(?<!\p{L})(?:бул|ул)(?!\p{L})\.?/giu)];
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < markers.length ? (markers[i + 1].index ?? text.length) : text.length;
    const seg = text.slice(start, end);

    let name = "";
    let rest = seg;
    const quoted = seg.match(/^\s*"([^"]+)"/);
    if (quoted) {
      name = quoted[1];
      rest = seg.slice(quoted[0].length);
    } else {
      const unquoted = seg.match(/^\s*([^"№\d,.;]+)/);
      if (unquoted) {
        name = unquoted[1].trim();
        rest = seg.slice(unquoted[0].length);
      }
    }
    const nums = new Set([...rest.matchAll(/\d+/g)].map((x) => x[0]));
    if (name) out.push([norm(name), nums]);
  }
  return out;
}

const WHOLE_NEIGHBORHOOD_KW = ["whole neighborhood"];
// BG renders "whole neighborhood" with several inflections of цял/цел.
const WHOLE_NEIGHBORHOOD_RE = /ц[ея]л\p{L}*\s+квартал/u;

export function isWholeNeighborhood(text: string): boolean {
  const n = norm(text);
  return WHOLE_NEIGHBORHOOD_KW.some((kw) => n.includes(kw)) || WHOLE_NEIGHBORHOOD_RE.test(n);
}

const POLYGON_KW = ["в участъка", "между", "between"];

export function isPolygon(text: string): boolean {
  const n = norm(text);
  return POLYGON_KW.some((kw) => n.includes(kw));
}

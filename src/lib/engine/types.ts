/**
 * Core data shapes for the matching engine. Ported from toplo_monitor.py's
 * Address / Outage dataclasses. Field names are camelCase here; the scraper
 * maps toplo.bg's `info` JSON onto Outage.
 */

export interface Address {
  label: string;
  /** MUST match toplo's naming, e.g. "Борово" (used only when geometry absent). */
  neighborhood: string;
  street?: string;
  houseNumber?: string;
  block?: string;
  /** Enables exact point-in-polygon matching when the outage has geometry. */
  lat?: number | null;
  lng?: number | null;
  channels?: string[];
}

export type OutageKind = "accident" | "repairs";

export interface Outage {
  /** Normalized neighborhood, e.g. "Борово". */
  neighborhood: string;
  /** Raw area description, e.g. 'бл.45 от вх.1 до вх.6'. */
  areaText: string;
  kind?: OutageKind;
  /** ISO-ish strings as shown on the site. */
  start?: string | null;
  recovery?: string | null;
  /** Exterior rings of the affected area; each ring is a list of [lng, lat]. */
  polygons?: Array<Array<[number, number]>>;
}

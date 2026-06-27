/**
 * Address↔outage matching and time-phase classification. Faithful port of the
 * Python matcher: geometry is authoritative when both sides have it; otherwise
 * fall back to neighborhood + block/street/whole-neighborhood/polygon text.
 */
import type { Address, Outage } from "./types";
import { norm, isWholeNeighborhood, isPolygon, parseBlocks, parseStreets } from "./text";
import { pointInPolygon } from "./geo";

export const Tier = {
  AFFECTED: "affected",
  LIKELY: "likely",
  POSSIBLE: "possible",
  CLEAR: "clear",
} as const;
export type TierValue = (typeof Tier)[keyof typeof Tier];

export const TIER_RANK: Record<TierValue, number> = {
  affected: 3,
  likely: 2,
  possible: 1,
  clear: 0,
};

export type Phase = "upcoming" | "active" | "ended";

function parseDt(s?: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 'upcoming' (planned, not started), 'active' (in progress), or 'ended'. */
export function outagePhase(o: Outage, now: Date = new Date()): Phase {
  const start = parseDt(o.start);
  const until = parseDt(o.recovery);
  if (until && until < now) return "ended";
  if (start && start > now) return "upcoming";
  return "active";
}

export function matchAddress(addr: Address, o: Outage): [TierValue, string] {
  // Geometry is authoritative when both the address and the outage have it.
  if (addr.lat != null && addr.lng != null && o.polygons && o.polygons.length) {
    const inside = o.polygons.some((ring) => pointInPolygon(addr.lng!, addr.lat!, ring));
    return inside
      ? [Tier.AFFECTED, "address falls inside the outage polygon"]
      : [Tier.CLEAR, "address falls outside the outage polygon"];
  }

  if (norm(addr.neighborhood) !== norm(o.neighborhood)) return [Tier.CLEAR, "different neighborhood"];

  const text = o.areaText;
  if (isWholeNeighborhood(text)) return [Tier.AFFECTED, "whole neighborhood is affected"];

  const blocks = parseBlocks(text);
  if (blocks.size && addr.block) {
    if (blocks.has(addr.block.toUpperCase())) return [Tier.AFFECTED, `block ${addr.block} is listed`];
    return [Tier.POSSIBLE, `blocks listed (${[...blocks].sort().join(", ")}); yours not among them`];
  }

  const streets = parseStreets(text);
  if (streets.length && addr.street) {
    const astreet = norm(addr.street);
    for (const [sname, nums] of streets) {
      if (astreet && (sname.includes(astreet) || astreet.includes(sname))) {
        if (nums.size === 0) return [Tier.LIKELY, `street '${addr.street}' named (no house numbers given)`];
        if (addr.houseNumber && nums.has(addr.houseNumber.replace(/\D/g, "")))
          return [Tier.AFFECTED, `street and number ${addr.houseNumber} listed`];
        return [Tier.LIKELY, `street '${addr.street}' listed (numbers: ${[...nums].sort().join(", ")})`];
      }
    }
  }

  if (isPolygon(text)) return [Tier.POSSIBLE, "area defined by surrounding streets — verify boundary"];
  return [Tier.POSSIBLE, "same neighborhood; area description unrecognized — verify"];
}

export interface Hit {
  outage: Outage;
  tier: TierValue;
  reason: string;
}

/** For each address, the outages at tier POSSIBLE or stronger, strongest first. */
export function evaluate(addresses: Address[], outages: Outage[]): Map<string, Hit[]> {
  const results = new Map<string, Hit[]>();
  for (const addr of addresses) {
    const hits: Hit[] = [];
    for (const o of outages) {
      const [tier, reason] = matchAddress(addr, o);
      if (TIER_RANK[tier] >= TIER_RANK[Tier.POSSIBLE]) hits.push({ outage: o, tier, reason });
    }
    if (hits.length) {
      hits.sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);
      results.set(addr.label, hits);
    }
  }
  return results;
}

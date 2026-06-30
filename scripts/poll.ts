/**
 * Outage poller (Phase 5). Runs on the GitHub cron. Fetches toplo.bg once,
 * upserts current outages, evaluates every user's pinned addresses, and emails
 * new matches + resolutions. Dedup lives in the SentNotification table (one row
 * per address+outage), so this is the multi-user successor to state.json.
 *
 * Persistence is deferred until each user's email actually sends: if the email
 * fails, nothing is written for that user and the next run retries cleanly.
 */
import { PrismaClient } from "@prisma/client";
import { parseOutagesHtml } from "../src/lib/engine/parse";
import { matchAddress, outagePhase, Tier, TIER_RANK } from "../src/lib/engine/match";
import type { Outage as EngineOutage, Address as EngineAddress } from "../src/lib/engine/types";
import { sendMail, getTransport } from "../src/lib/mailer";

const ACCIDENTS_URL = "https://toplo.bg/accidents-and-maintenance";
const CABINET_URL = process.env.APP_URL ?? "https://toplo-monitor.vercel.app/cabinet";

const prisma = new PrismaClient();

function parseDt(s?: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

type NewItem = {
  type: "new";
  addressId: string;
  outageId: string;
  addressLabel: string;
  engine: EngineOutage;
  tier: string;
  reason: string;
  phase: string;
};
type ResolvedItem = {
  type: "resolved";
  notifId: string;
  addressLabel: string;
  engine: EngineOutage;
};
type UserBatch = { email: string; items: (NewItem | ResolvedItem)[] };

function formatItem(item: NewItem | ResolvedItem): string {
  if (item.type === "resolved") {
    return [
      `✅ RESOLVED — ${item.addressLabel}`,
      `Neighborhood: ${item.engine.neighborhood}`,
      `Area: ${item.engine.areaText}`,
    ].join("\n");
  }
  const kind = item.engine.kind === "repairs" ? "Planned" : "Accident";
  const when = item.phase === "upcoming" ? "UPCOMING" : "ACTIVE";
  const lines = [
    `⚠️ ${item.tier.toUpperCase()} · ${kind} · ${when} — ${item.addressLabel}`,
    `Neighborhood: ${item.engine.neighborhood}`,
    `Area: ${item.engine.areaText}`,
    `Why: ${item.reason}`,
  ];
  if (item.engine.start) lines.push(`Starts: ${item.engine.start}`);
  if (item.engine.recovery) lines.push(`Expected back: ${item.engine.recovery}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const now = new Date();

  const res = await fetch(ACCIDENTS_URL, { headers: { "User-Agent": "toplo-monitor/2.0" } });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
  const parsed = parseOutagesHtml(await res.text());
  // Keep active + upcoming; an ended outage simply drops out and resolves.
  const live = parsed.filter((o) => o.accidentId && outagePhase(o, now) !== "ended");

  // Upsert outages; map accidentId -> { dbId, engine }.
  const byAccident = new Map<string, { id: string; engine: EngineOutage }>();
  for (const o of live) {
    const rec = await prisma.outage.upsert({
      where: { accidentId: o.accidentId! },
      create: {
        accidentId: o.accidentId!,
        neighborhood: o.neighborhood,
        areaText: o.areaText,
        kind: o.kind ?? "accident",
        startAt: parseDt(o.start),
        recoveryAt: parseDt(o.recovery),
        polygons: o.polygons ?? [],
      },
      update: {
        neighborhood: o.neighborhood,
        areaText: o.areaText,
        kind: o.kind ?? "accident",
        startAt: parseDt(o.start),
        recoveryAt: parseDt(o.recovery),
        polygons: o.polygons ?? [],
      },
    });
    byAccident.set(o.accidentId!, { id: rec.id, engine: o });
  }

  const addresses = await prisma.address.findMany({ include: { user: true } });
  const openNotifs = await prisma.sentNotification.findMany({ where: { resolvedAt: null } });
  const key = (addressId: string, outageId: string) => `${addressId}::${outageId}`;
  const openSet = new Set(openNotifs.map((n) => key(n.addressId, n.outageId)));

  const batches = new Map<string, UserBatch>(); // userId -> batch
  const add = (userId: string, email: string | null, item: NewItem | ResolvedItem) => {
    if (!email) return;
    const b = batches.get(userId) ?? { email, items: [] };
    b.items.push(item);
    batches.set(userId, b);
  };

  const currentMatches = new Set<string>();

  // New / recurring matches.
  for (const addr of addresses) {
    const engineAddr: EngineAddress = {
      label: addr.label,
      neighborhood: addr.neighborhood,
      street: addr.street,
      houseNumber: addr.houseNumber,
      block: addr.block,
      lat: addr.lat,
      lng: addr.lng,
    };
    for (const { id: outageId, engine } of byAccident.values()) {
      const [tier, reason] = matchAddress(engineAddr, engine);
      if (TIER_RANK[tier] < TIER_RANK[Tier.POSSIBLE]) continue;
      const k = key(addr.id, outageId);
      currentMatches.add(k);
      if (!openSet.has(k)) {
        add(addr.userId, addr.user.email, {
          type: "new",
          addressId: addr.id,
          outageId,
          addressLabel: addr.label,
          engine,
          tier,
          reason,
          phase: outagePhase(engine, now),
        });
      }
    }
  }

  // Resolutions: open notifications that no longer match.
  for (const n of openNotifs) {
    if (currentMatches.has(key(n.addressId, n.outageId))) continue;
    const addr = addresses.find((a) => a.id === n.addressId);
    const outage = await prisma.outage.findUnique({ where: { id: n.outageId } });
    if (!addr || !outage) {
      // Address or outage gone — just close the notification.
      await prisma.sentNotification.update({ where: { id: n.id }, data: { resolvedAt: now } });
      continue;
    }
    add(addr.userId, addr.user.email, {
      type: "resolved",
      notifId: n.id,
      addressLabel: addr.label,
      engine: {
        neighborhood: outage.neighborhood,
        areaText: outage.areaText,
        kind: outage.kind === "repairs" ? "repairs" : "accident",
        start: outage.startAt?.toISOString() ?? null,
        recovery: outage.recoveryAt?.toISOString() ?? null,
      },
    });
  }

  if (!getTransport()) {
    console.warn("SMTP not configured — skipping send (no notifications persisted).");
    console.log(`outages=${live.length} pendingUsers=${batches.size}`);
    return;
  }

  let sent = 0;
  for (const [, batch] of batches) {
    const newCount = batch.items.filter((i) => i.type === "new").length;
    const resolvedCount = batch.items.length - newCount;
    const body =
      batch.items.map(formatItem).join("\n\n") + `\n\n—\nManage your addresses: ${CABINET_URL}`;
    const subject = `toplo: ${newCount} new, ${resolvedCount} resolved`;
    try {
      await sendMail(batch.email, subject, body);
    } catch (err) {
      console.error(`Email to ${batch.email} failed, will retry next run:`, err);
      continue; // don't persist -> clean retry
    }
    // Persist only after a successful send.
    for (const item of batch.items) {
      if (item.type === "new") {
        await prisma.sentNotification.upsert({
          where: { addressId_outageId: { addressId: item.addressId, outageId: item.outageId } },
          create: {
            addressId: item.addressId,
            outageId: item.outageId,
            tier: item.tier,
            reason: item.reason,
            phase: item.phase,
          },
          update: { tier: item.tier, reason: item.reason, phase: item.phase, sentAt: now, resolvedAt: null },
        });
      } else {
        await prisma.sentNotification.update({ where: { id: item.notifId }, data: { resolvedAt: now } });
      }
    }
    sent++;
  }

  console.log(`outages=${live.length} emailsSent=${sent} users=${batches.size}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

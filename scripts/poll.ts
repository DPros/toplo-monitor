/**
 * Outage poller (Phase 5). Runs on the GitHub cron. Fetches toplo.bg once,
 * upserts current outages, evaluates every user's pinned addresses, and emails
 * new matches + resolutions. State/dedup lives in the SentNotification table —
 * the multi-user successor to state.json.
 *
 * Identity is the outage CONTENT (neighborhood|areaText), not toplo's AccidentId,
 * because toplo rotates ids / lists the same outage twice — keying on the id
 * caused the same outage to re-alert and falsely resolve.
 *
 * Persistence of user-facing alerts is deferred until each user's email actually
 * sends: if the email fails, nothing is written for that user and the next run
 * retries cleanly. Pure bookkeeping (id migration, duplicate cleanup) is applied
 * regardless.
 */
import { PrismaClient } from "@prisma/client";
import { parseOutagesHtml } from "../src/lib/engine/parse";
import { matchAddress, outagePhase, Tier, TIER_RANK, type TierValue } from "../src/lib/engine/match";
import type { Outage as EngineOutage, Address as EngineAddress } from "../src/lib/engine/types";
import { sendMail, getTransport } from "../src/lib/mailer";

const ACCIDENTS_URL = "https://toplo.bg/accidents-and-maintenance";
const CABINET_URL = process.env.APP_URL ?? "https://toplo-monitor.vercel.app/cabinet";
// toplo.bg has no per-outage deep link (outages are highlighted on the map via
// JS, the URL never changes), so we link the official list page.
const TOPLO_URL = "https://toplo.bg/accidents-and-maintenance";

const prisma = new PrismaClient();

/** Stable outage identity: content, not the volatile AccidentId. */
const contentKey = (neighborhood: string, areaText: string) =>
  `${neighborhood.trim()}|${areaText.trim()}`.toLowerCase();

/** Fetch the accidents page with retries — runner↔toplo.bg can be flaky/slow. */
async function fetchAccidentsHtml(): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(ACCIDENTS_URL, {
        headers: { "User-Agent": "toplo-monitor/2.0" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      console.warn(`fetch attempt ${attempt}/3 failed:`, err instanceof Error ? err.message : err);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  throw lastErr;
}

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
  tier: TierValue;
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
  const kind = item.engine.kind === "repairs" ? "Planned maintenance" : "Accident";
  if (item.type === "resolved") {
    return [
      `✅ RESOLVED · ${kind} — ${item.addressLabel}`,
      `Neighborhood: ${item.engine.neighborhood}`,
      `Area: ${item.engine.areaText}`,
    ].join("\n");
  }
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

  const parsed = parseOutagesHtml(await fetchAccidentsHtml());
  // Everything still listed on the page is current. toplo.bg keeps outages
  // listed past their stated recovery time (they get extended), so page
  // presence is authoritative — NOT UntilDate. An outage resolves only when it
  // drops off the page (handled by the resolution pass below).
  const live = parsed.filter((o) => o.accidentId);

  // Cache outages keyed by content (one row per neighborhood|areaText). Duplicate
  // listings / churned ids collapse to a single row. accidentId is kept only as
  // a reference.
  const byContent = new Map<string, { id: string; engine: EngineOutage }>();
  const seenKeys = new Set<string>();
  for (const o of live) {
    const ck = contentKey(o.neighborhood, o.areaText);
    seenKeys.add(ck);
    const rec = await prisma.outage.upsert({
      where: { key: ck },
      create: {
        key: ck,
        accidentId: o.accidentId,
        neighborhood: o.neighborhood,
        areaText: o.areaText,
        kind: o.kind ?? "accident",
        startAt: parseDt(o.start),
        recoveryAt: parseDt(o.recovery),
        polygons: o.polygons ?? [],
      },
      update: {
        accidentId: o.accidentId,
        neighborhood: o.neighborhood,
        areaText: o.areaText,
        kind: o.kind ?? "accident",
        startAt: parseDt(o.start),
        recoveryAt: parseDt(o.recovery),
        polygons: o.polygons ?? [],
      },
    });
    byContent.set(ck, { id: rec.id, engine: o });
  }

  const addresses = await prisma.address.findMany({ include: { user: true } });
  const openNotifs = await prisma.sentNotification.findMany({ where: { resolvedAt: null } });

  // Strongest current match per (address, content).
  type CurMatch = {
    addressId: string;
    userId: string;
    email: string | null;
    addressLabel: string;
    outageId: string;
    engine: EngineOutage;
    tier: TierValue;
    reason: string;
    phase: string;
  };
  const curByAkey = new Map<string, CurMatch>();
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
    for (const { id: outageId, engine } of byContent.values()) {
      const [tier, reason] = matchAddress(engineAddr, engine);
      if (TIER_RANK[tier] < TIER_RANK[Tier.POSSIBLE]) continue;
      const akey = `${addr.id}::${contentKey(engine.neighborhood, engine.areaText)}`;
      const prev = curByAkey.get(akey);
      if (!prev || TIER_RANK[tier] > TIER_RANK[prev.tier]) {
        curByAkey.set(akey, {
          addressId: addr.id,
          userId: addr.userId,
          email: addr.user.email,
          addressLabel: addr.label,
          outageId,
          engine,
          tier,
          reason,
          phase: outagePhase(engine, now),
        });
      }
    }
  }

  // Group open notifications by (address, content) via their cached outage.
  const openOutages = await prisma.outage.findMany({
    where: { id: { in: [...new Set(openNotifs.map((n) => n.outageId))] } },
  });
  const outageById = new Map(openOutages.map((o) => [o.id, o]));
  const akeyOf = (n: (typeof openNotifs)[number]): string => {
    const o = outageById.get(n.outageId);
    const ck = o ? contentKey(o.neighborhood, o.areaText) : `__gone__:${n.outageId}`;
    return `${n.addressId}::${ck}`;
  };
  const openByAkey = new Map<string, typeof openNotifs>();
  for (const n of openNotifs) {
    const ak = akeyOf(n);
    const arr = openByAkey.get(ak);
    if (arr) arr.push(n);
    else openByAkey.set(ak, [n]);
  }

  const batches = new Map<string, UserBatch>(); // userId -> batch
  const add = (userId: string, email: string | null, item: NewItem | ResolvedItem) => {
    if (!email) return;
    const b = batches.get(userId) ?? { email, items: [] };
    b.items.push(item);
    batches.set(userId, b);
  };
  const migrates: { id: string; outageId: string }[] = []; // repoint a notif at the current outage row
  const silentResolves: string[] = []; // close duplicates/orphans without emailing

  // New alerts / id-churn migration.
  for (const [akey, m] of curByAkey) {
    const group = openByAkey.get(akey);
    if (!group || group.length === 0) {
      add(m.userId, m.email, {
        type: "new",
        addressId: m.addressId,
        outageId: m.outageId,
        addressLabel: m.addressLabel,
        engine: m.engine,
        tier: m.tier,
        reason: m.reason,
        phase: m.phase,
      });
    } else {
      // Already notified about this outage. Keep one notification pointed at the
      // current outage row; silently close any duplicates. No new email.
      if (group[0].outageId !== m.outageId) migrates.push({ id: group[0].id, outageId: m.outageId });
      for (const extra of group.slice(1)) silentResolves.push(extra.id);
    }
  }

  // Resolutions: content no longer present on the page.
  for (const [akey, group] of openByAkey) {
    if (curByAkey.has(akey)) continue;
    const first = group[0];
    const o = outageById.get(first.outageId);
    const addr = addresses.find((a) => a.id === first.addressId);
    if (addr?.user.email && o) {
      add(addr.userId, addr.user.email, {
        type: "resolved",
        notifId: first.id,
        addressLabel: addr.label,
        engine: {
          neighborhood: o.neighborhood,
          areaText: o.areaText,
          kind: o.kind === "repairs" ? "repairs" : "accident",
          start: o.startAt?.toISOString() ?? null,
          recovery: o.recoveryAt?.toISOString() ?? null,
        },
      });
      for (const extra of group.slice(1)) silentResolves.push(extra.id);
    } else {
      for (const n of group) silentResolves.push(n.id);
    }
  }

  // Bookkeeping that doesn't depend on email delivery.
  for (const mg of migrates) {
    try {
      await prisma.sentNotification.update({ where: { id: mg.id }, data: { outageId: mg.outageId } });
    } catch {
      // Target already has a notification — just close this duplicate.
      await prisma.sentNotification.update({ where: { id: mg.id }, data: { resolvedAt: now } });
    }
  }
  for (const id of silentResolves) {
    await prisma.sentNotification.update({ where: { id }, data: { resolvedAt: now } });
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
      batch.items.map(formatItem).join("\n\n") +
      `\n\n—\nLive status & details on toplo.bg: ${TOPLO_URL}` +
      `\nManage your addresses: ${CABINET_URL}`;
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

  // Drop stale cache rows: outages no longer on the page that nothing references.
  // (Rows with notifications are kept so resolution + history stay intact.)
  if (seenKeys.size > 0) {
    const removed = await prisma.outage.deleteMany({
      where: { key: { notIn: [...seenKeys] }, notifications: { none: {} } },
    });
    if (removed.count) console.log(`cleaned ${removed.count} stale outage rows`);
  }

  console.log(`outages=${live.length} emailsSent=${sent} users=${batches.size}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

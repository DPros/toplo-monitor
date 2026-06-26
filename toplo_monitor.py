#!/usr/bin/env python3
"""
toplo-monitor
=============
Monitors Toplofikatsia Sofia's outage page (toplo.bg) and notifies when any of
your monitored addresses is (or might be) affected by a hot-water / heating cut.

Design notes
------------
* The ONLY part you must finalize against the live site is `fetch_raw_outages()`.
  Everything downstream (parsing, address matching, dedup, notifications) is
  generic and unit-tested against the real strings seen on the site.
* Matching returns a CONFIDENCE TIER, not a yes/no, because many outages are
  described as an area "between four streets" which cannot be resolved to a
  single address without polygon geometry. See `Tier`.
* State is a JSON file so it can live in the repo and be committed back by the
  GitHub Action — that is what prevents duplicate notifications.

Configuration is via environment variables (see README). Addresses live in
addresses.json.
"""
from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from hashlib import sha1
from pathlib import Path
from typing import Any

# --------------------------------------------------------------------------- #
# Paths / constants
# --------------------------------------------------------------------------- #

ROOT = Path(__file__).resolve().parent
ADDRESSES_FILE = ROOT / "addresses.json"
STATE_FILE = ROOT / "state.json"

# Bulgarian page is canonical; English page often leaves descriptions in BG.
ACCIDENTS_URL = "https://toplo.bg/accidents-and-maintenance"

# Keywords (lowercased) used by the matcher. Add variants as you see them.
WHOLE_NEIGHBORHOOD_KW = ("whole neighborhood",)
# Bulgarian renders "whole neighborhood" with several inflections of цял/цел —
# целия / целият / цялата / цялия квартал — so match the stem, not exact forms.
WHOLE_NEIGHBORHOOD_RE = re.compile(r"ц[ея]л\w*\s+квартал")
POLYGON_KW = ("в участъка", "между", "between")


# --------------------------------------------------------------------------- #
# Data models
# --------------------------------------------------------------------------- #

class Tier:
    """Match confidence, ordered from strongest to weakest."""
    AFFECTED = "affected"        # certainly within the outage
    LIKELY = "likely"            # strong textual match (e.g. street named)
    POSSIBLE = "possible"        # right neighborhood, area can't be resolved
    CLEAR = "clear"              # not affected

    RANK = {AFFECTED: 3, LIKELY: 2, POSSIBLE: 1, CLEAR: 0}


@dataclass
class Outage:
    neighborhood: str            # normalized, e.g. "Борово"
    area_text: str               # raw description, e.g. 'бл.45 от вх.1 до вх.6'
    kind: str = "accident"       # "accident" | "repairs"
    start: str | None = None     # ISO-ish string as shown on site
    recovery: str | None = None  # expected recovery, as shown
    lat: float | None = None     # if the map endpoint provides geometry
    lng: float | None = None
    # Exterior rings of the affected area, each a list of (lng, lat) vertices.
    # Populated from the page's GeoJSON; enables exact point-in-polygon matching.
    polygons: list[list[tuple[float, float]]] = field(default_factory=list)

    @property
    def key(self) -> str:
        """Stable identity for dedup across polls."""
        raw = f"{self.neighborhood}|{self.area_text}|{self.start}"
        return sha1(raw.encode("utf-8")).hexdigest()[:16]


@dataclass
class Address:
    label: str                   # human name, e.g. "Home"
    neighborhood: str            # MUST match toplo's naming, e.g. "Борово"
    street: str = ""             # e.g. "Топли дол"
    house_number: str = ""       # e.g. "1а"
    block: str = ""              # e.g. "206" (for block-style neighborhoods)
    lat: float | None = None     # optional, enables polygon matching later
    lng: float | None = None
    channels: list[str] = field(default_factory=list)  # override notify routing


# --------------------------------------------------------------------------- #
# Text normalization helpers
# --------------------------------------------------------------------------- #

def norm(s: str | None) -> str:
    """Lowercase, collapse whitespace, unify quotes — for robust comparisons."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    s = s.replace("„", '"').replace("“", '"').replace("”", '"').replace("’", "'")
    s = re.sub(r"\s+", " ", s)
    return s.strip().lower()


def strip_neighborhood(header: str) -> str:
    """'Part of Borovo' / 'Част от Борово' -> 'Borovo' / 'Борово'."""
    h = header.strip()
    for prefix in ("Part of ", "Част от ", "part of ", "част от "):
        if h.startswith(prefix):
            return h[len(prefix):].strip()
    return h


# No \s* before the optional letter: '206А' attaches, but 'бл.206 вх' does not
# swallow the 'в' from the entrance abbreviation 'вх.'.
_BLOCK_RE = re.compile(r"бл\.?\s*(\d+[А-Яа-я]?)", re.IGNORECASE)


def parse_blocks(text: str) -> set[str]:
    """Extract block identifiers from text like 'бл.206, бл.206А, бл.207А'.

    Also handles bare comma lists after a 'бл.' such as 'Бл.14,15,16 и 17'.
    """
    found: set[str] = set()
    t = text
    for m in _BLOCK_RE.finditer(t):
        found.add(re.sub(r"\s+", "", m.group(1)).upper())
    # Handle 'бл.14,15,16 и 17' — numbers chained after the first 'бл.'
    m = re.search(r"бл\.?\s*([\d\sА-Яа-я,и]+)", t, re.IGNORECASE)
    if m:
        for tok in re.split(r"[,\s]+|\bи\b", m.group(1)):
            tok = tok.strip()
            if re.fullmatch(r"\d+[А-Яа-я]?", tok):
                found.add(tok.upper())
    return found


_MARKER_RE = re.compile(r"(?:ул|бул)\b\.?", re.IGNORECASE)


def parse_streets(text: str) -> list[tuple[str, set[str]]]:
    """Return [(street_name_normalized, {house_numbers}), ...].

    Works by locating each 'ул.'/'бул.' marker and parsing the segment up to
    the next marker, so chained lists and trailing notes don't break it.
    """
    out: list[tuple[str, set[str]]] = []
    markers = list(_MARKER_RE.finditer(text))
    for i, m in enumerate(markers):
        start = m.end()
        end = markers[i + 1].start() if i + 1 < len(markers) else len(text)
        seg = text[start:end]
        q = re.match(r'\s*"([^"]+)"', seg)
        if q:
            name, rest = q.group(1), seg[q.end():]
        else:
            u = re.match(r"\s*([^\"№\d,.;]+)", seg)
            name, rest = (u.group(1).strip(), seg[u.end():]) if u else ("", seg)
        nums = set(re.findall(r"\d+", rest))
        if name:
            out.append((norm(name), nums))
    return out


def is_whole_neighborhood(text: str) -> bool:
    n = norm(text)
    return any(kw in n for kw in WHOLE_NEIGHBORHOOD_KW) or bool(WHOLE_NEIGHBORHOOD_RE.search(n))


def is_polygon(text: str) -> bool:
    n = norm(text)
    return any(kw in n for kw in POLYGON_KW)


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #

def rings_from_geojson(serialized: str | None) -> list[list[tuple[float, float]]]:
    """Parse a GeoJSON string into exterior rings of (lng, lat) vertices.

    toplo.bg serializes geometry as a JSON array of Features (occasionally a
    single Feature or bare geometry). We keep only the exterior ring of each
    Polygon (and of each member of a MultiPolygon) — enough for containment.
    """
    if not serialized:
        return []
    try:
        data = json.loads(serialized)
    except (json.JSONDecodeError, TypeError):
        return []

    features = data if isinstance(data, list) else [data]
    rings: list[list[tuple[float, float]]] = []
    for feat in features:
        if not isinstance(feat, dict):
            continue
        geom = feat.get("geometry", feat)
        if not isinstance(geom, dict):
            continue
        gtype, coords = geom.get("type"), geom.get("coordinates")
        if not coords:
            continue
        if gtype == "Polygon":
            rings.append([(float(x), float(y)) for x, y in coords[0]])
        elif gtype == "MultiPolygon":
            for poly in coords:
                if poly:
                    rings.append([(float(x), float(y)) for x, y in poly[0]])
    return rings


def point_in_polygon(lng: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    """Ray-casting containment test. `ring` is a list of (lng, lat) vertices."""
    inside = False
    n = len(ring)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lng < x_cross:
                inside = not inside
        j = i
    return inside


# --------------------------------------------------------------------------- #
# Matching
# --------------------------------------------------------------------------- #

def match_address(addr: Address, o: Outage) -> tuple[str, str]:
    """Return (tier, human-readable reason)."""
    # Geometry is authoritative when BOTH the address and the outage have it:
    # the polygon is exactly the area toplo.bg draws on its map, so containment
    # resolves the otherwise-ambiguous "area between four streets" cases.
    if addr.lat is not None and addr.lng is not None and o.polygons:
        if any(point_in_polygon(addr.lng, addr.lat, r) for r in o.polygons):
            return Tier.AFFECTED, "address falls inside the outage polygon"
        return Tier.CLEAR, "address falls outside the outage polygon"

    if norm(addr.neighborhood) != norm(o.neighborhood):
        return Tier.CLEAR, "different neighborhood"

    text = o.area_text

    if is_whole_neighborhood(text):
        return Tier.AFFECTED, "whole neighborhood is affected"

    # Block-style description
    blocks = parse_blocks(text)
    if blocks and addr.block:
        if addr.block.upper() in blocks:
            return Tier.AFFECTED, f"block {addr.block} is listed"
        # Blocks are listed but yours isn't -> probably clear, but stay cautious
        return Tier.POSSIBLE, f"blocks listed ({', '.join(sorted(blocks))}); yours not among them"

    # Street-style description
    streets = parse_streets(text)
    if streets and addr.street:
        astreet = norm(addr.street)
        for sname, nums in streets:
            if astreet and (astreet in sname or sname in astreet):
                if not nums:
                    return Tier.LIKELY, f"street '{addr.street}' named (no house numbers given)"
                if addr.house_number and re.sub(r"\D", "", addr.house_number) in nums:
                    return Tier.AFFECTED, f"street and number {addr.house_number} listed"
                return Tier.LIKELY, f"street '{addr.street}' listed (numbers: {', '.join(sorted(nums))})"

    # Area-between-streets polygon with no usable geometry/coords to resolve it.
    # (When geometry IS present, the point-in-polygon branch above already
    # decided AFFECTED/CLEAR and we never reach here.)
    if is_polygon(text):
        return Tier.POSSIBLE, "area defined by surrounding streets — verify boundary"

    # Same neighborhood, undetermined description
    return Tier.POSSIBLE, "same neighborhood; area description unrecognized — verify"


def evaluate(addresses: list[Address], outages: list[Outage]) -> dict[str, list[dict]]:
    """For each address, list outages at tier POSSIBLE or stronger."""
    results: dict[str, list[dict]] = {}
    for addr in addresses:
        hits = []
        for o in outages:
            tier, reason = match_address(addr, o)
            if Tier.RANK[tier] >= Tier.RANK[Tier.POSSIBLE]:
                hits.append({"outage": o, "tier": tier, "reason": reason})
        if hits:
            hits.sort(key=lambda h: Tier.RANK[h["tier"]], reverse=True)
            results[addr.label] = hits
    return results


# --------------------------------------------------------------------------- #
# Time / phase
# --------------------------------------------------------------------------- #

class Phase:
    UPCOMING = "upcoming"   # planned, not started yet  -> notify ahead of time
    ACTIVE = "active"       # in progress right now
    ENDED = "ended"         # window is over -> drop (and report as resolved)


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def outage_phase(o: Outage, now: datetime | None = None) -> str:
    """Classify an outage by its time window relative to `now` (UTC)."""
    now = now or datetime.now(timezone.utc)
    start, until = _parse_dt(o.start), _parse_dt(o.recovery)
    if until and until < now:
        return Phase.ENDED
    if start and start > now:
        return Phase.UPCOMING
    return Phase.ACTIVE


# --------------------------------------------------------------------------- #
# Fetching
# --------------------------------------------------------------------------- #

# The page embeds one `var info = {...}` object per outage inside an inline
# <script> comment. The object is JSON; we locate each occurrence and let the
# JSON decoder consume exactly one value (raw_decode handles the braces that
# appear *inside* the GeolocationSerialized string, which a brace-counter or a
# greedy/lazy regex would choke on).
_INFO_RE = re.compile(r"var\s+info\s*=\s*")


def parse_outages_html(html: str) -> list[Outage]:
    """Extract outages from the page HTML. Pure function — unit-testable."""
    decoder = json.JSONDecoder()
    outages: list[Outage] = []
    seen: set[str] = set()

    for m in _INFO_RE.finditer(html):
        try:
            info, _ = decoder.raw_decode(html, m.end())
        except json.JSONDecodeError:
            continue
        if not isinstance(info, dict):
            continue

        ident = info.get("AccidentId") or info.get("ContentItemId")
        if ident and ident in seen:
            continue
        if ident:
            seen.add(ident)

        # "Region" is the bare neighborhood ("Люлин 9"); "Name" prefixes it with
        # "Част от …". Prefer Region, fall back to the stripped Name.
        neighborhood = (info.get("Region") or "").strip()
        if not neighborhood:
            neighborhood = strip_neighborhood((info.get("Name") or "").strip())

        outages.append(Outage(
            neighborhood=neighborhood,
            area_text=(info.get("Addresses") or "").strip(),
            kind="repairs" if info.get("Type") else "accident",
            start=info.get("FromDate"),
            recovery=info.get("UntilDate"),
            polygons=rings_from_geojson(info.get("GeolocationSerialized")),
        ))
    return outages


def fetch_raw_outages() -> list[Outage]:
    """Fetch current outages from toplo.bg and parse them into `Outage`s.

    The outage list and its geometry are rendered straight into the page as
    per-outage `var info = {…}` blocks (Name, Addresses, Region, FromDate,
    UntilDate, Type and a GeoJSON `GeolocationSerialized`). No XHR/JS execution
    is needed — a single GET plus `parse_outages_html` gives us everything,
    including polygons for exact point-in-polygon matching.
    """
    import requests  # lazy import so the logic above is testable without deps

    resp = requests.get(
        ACCIDENTS_URL,
        headers={"User-Agent": "toplo-monitor/1.0 (personal outage notifier)"},
        timeout=30,
    )
    resp.raise_for_status()
    return parse_outages_html(resp.text)


# --------------------------------------------------------------------------- #
# State / diff
# --------------------------------------------------------------------------- #

def load_addresses() -> list[Address]:
    data = json.loads(ADDRESSES_FILE.read_text(encoding="utf-8"))
    return [Address(**a) for a in data]


def load_state() -> dict[str, Any]:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {"active": {}}


def save_state(state: dict[str, Any]) -> None:
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def diff(prev_active: dict, results: dict[str, list[dict]]) -> tuple[list, list, dict]:
    """Compare current matches to previous state.

    Returns (new_alerts, resolved_alerts, new_active_map).
    Each alert is keyed by (address_label, outage.key) so we notify once.
    """
    new_active: dict[str, dict] = {}
    new_alerts, resolved = [], []

    seen_keys = set()
    for label, hits in results.items():
        for hit in hits:
            o: Outage = hit["outage"]
            sid = f"{label}::{o.key}"
            seen_keys.add(sid)
            record = {
                "label": label,
                "tier": hit["tier"],
                "reason": hit["reason"],
                "neighborhood": o.neighborhood,
                "area_text": o.area_text,
                "kind": o.kind,
                "phase": outage_phase(o),
                "start": o.start,
                "recovery": o.recovery,
            }
            new_active[sid] = record
            if sid not in prev_active:
                new_alerts.append(record)

    for sid, record in prev_active.items():
        if sid not in seen_keys:
            resolved.append(record)

    return new_alerts, resolved, new_active


# --------------------------------------------------------------------------- #
# Notifications
# --------------------------------------------------------------------------- #

def _format_alert(record: dict, resolved: bool = False) -> str:
    if resolved:
        head = "✅ RESOLVED"
    else:
        kind = "Planned" if record.get("kind") == "repairs" else "Accident"
        when = "UPCOMING" if record.get("phase") == Phase.UPCOMING else "ACTIVE"
        head = f"⚠️ {record['tier'].upper()} · {kind} · {when}"
    lines = [
        f"{head} — {record['label']}",
        f"Neighborhood: {record['neighborhood']}",
        f"Area: {record['area_text']}",
    ]
    if not resolved:
        lines.append(f"Why: {record['reason']}")
        if record.get("start"):
            lines.append(f"Starts: {record['start']}")
        if record.get("recovery"):
            lines.append(f"Expected back: {record['recovery']}")
    return "\n".join(lines)


def notify_telegram(text: str) -> str:
    """Return a one-line human status (sent / skipped). Raises on a real error."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not (token and chat_id):
        return "telegram: skipped (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)"
    import requests
    r = requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True},
        timeout=30,
    )
    r.raise_for_status()
    return "telegram: sent"


def notify_email(subject: str, text: str) -> str:
    host = os.environ.get("SMTP_HOST")
    to = os.environ.get("EMAIL_TO", "")
    if not host:
        return "email: skipped (SMTP_HOST not set)"
    if not to:
        return "email: skipped (EMAIL_TO not set)"
    import smtplib
    from email.mime.text import MIMEText

    msg = MIMEText(text, _charset="utf-8")
    msg["Subject"] = subject
    msg["From"] = os.environ.get("EMAIL_FROM", os.environ.get("SMTP_USER", ""))
    msg["To"] = to

    port = int(os.environ.get("SMTP_PORT", "587"))
    user, pw = os.environ.get("SMTP_USER"), os.environ.get("SMTP_PASS")
    # Port 465 = implicit TLS (SMTP_SSL); 587/25 = plaintext + STARTTLS.
    if port == 465:
        ctx = smtplib.SMTP_SSL(host, port, timeout=30)
    else:
        ctx = smtplib.SMTP(host, port, timeout=30)
    with ctx as s:
        if port != 465:
            s.starttls()
        if user and pw:
            s.login(user, pw)
        s.send_message(msg)
    return f"email: sent to {to} via {host}:{port}"


def notify_webhook(payload: dict) -> str:
    url = os.environ.get("WEBHOOK_URL")
    if not url:
        return "webhook: skipped (WEBHOOK_URL not set)"
    import requests
    r = requests.post(url, json=payload, timeout=30)
    r.raise_for_status()
    return "webhook: sent"


def dispatch(new_alerts: list[dict], resolved: list[dict]) -> None:
    if not new_alerts and not resolved:
        print("No changes since last run — nothing to notify.")
        return

    sections = []
    sections += [_format_alert(r) for r in new_alerts]
    sections += [_format_alert(r, resolved=True) for r in resolved]
    text = "\n\n".join(sections)
    subject = f"toplo: {len(new_alerts)} new, {len(resolved)} resolved"

    # Fire each channel independently; one failing must not block the others.
    # Each notifier reports whether it sent or why it skipped, so the run log
    # shows exactly what happened (a silent skip looked identical to a failure).
    for fn, args in (
        (notify_telegram, (text,)),
        (notify_email, (subject, text)),
        (notify_webhook, ({"new": new_alerts, "resolved": resolved},)),
    ):
        try:
            print(fn(*args))
        except Exception as e:  # noqa: BLE001
            print(f"notifier {fn.__name__} failed: {e}", file=sys.stderr)

    print(text)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def _test_alert() -> dict:
    """A synthetic alert used by `--test` to exercise the delivery channels."""
    return {
        "label": "TEST", "tier": "affected", "reason": "test notification — ignore",
        "neighborhood": "—", "area_text": "If you received this, delivery works.",
        "kind": "accident", "phase": Phase.ACTIVE, "start": None, "recovery": None,
    }


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv

    # `--test`: send a sample notification through every configured channel and
    # exit, without touching the live site or state.json. Lets you confirm the
    # email/Telegram/webhook config end-to-end without waiting for a real outage.
    if "--test" in argv:
        print("Sending a TEST notification through all configured channels…")
        dispatch([_test_alert()], [])
        return 0

    addresses = load_addresses()
    state = load_state()
    now = datetime.now(timezone.utc)
    # Keep active + upcoming (planned) outages; drop ones whose window is over
    # so they don't fire stale alerts — and so they surface as RESOLVED instead.
    outages = [o for o in fetch_raw_outages() if outage_phase(o, now) != Phase.ENDED]
    results = evaluate(addresses, outages)
    new_alerts, resolved, new_active = diff(state.get("active", {}), results)
    dispatch(new_alerts, resolved)
    state["active"] = new_active
    state["last_run"] = datetime.now(timezone.utc).isoformat()
    save_state(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

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
WHOLE_NEIGHBORHOOD_KW = ("целия квартал", "цялия квартал", "whole neighborhood")
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
    return any(kw in n for kw in WHOLE_NEIGHBORHOOD_KW)


def is_polygon(text: str) -> bool:
    n = norm(text)
    return any(kw in n for kw in POLYGON_KW)


# --------------------------------------------------------------------------- #
# Matching
# --------------------------------------------------------------------------- #

def match_address(addr: Address, o: Outage) -> tuple[str, str]:
    """Return (tier, human-readable reason)."""
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

    # Area-between-streets polygon: cannot resolve from text alone
    if is_polygon(text):
        # If we have geometry + address coords, you could do point-in-polygon here.
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
# Fetching  — THE ONE INTEGRATION POINT TO FINALIZE
# --------------------------------------------------------------------------- #

def fetch_raw_outages() -> list[Outage]:
    """Fetch current outages from toplo.bg.

    STRATEGY (do this once, then delete the NotImplementedError):
      1. Open https://toplo.bg/accidents-and-maintenance, click the **Map** tab,
         and inspect the Network panel for an XHR/fetch returning JSON/GeoJSON.
         That payload almost certainly contains, per outage: neighborhood,
         description, start time, expected recovery, and coordinates/geometry.
         Parse THAT — it is stable and gives you geometry for polygon matching.
      2. Fallback: parse the HTML list. The detail blocks repeat as
         <neighborhood header> / <date> / <area text> / "Expected recovery ...".
         Confirm the actual tags/classes in your browser, then fill in below.

    Return a list[Outage].
    """
    import requests  # lazy import so the logic above is testable without deps
    from bs4 import BeautifulSoup  # type: ignore

    resp = requests.get(
        ACCIDENTS_URL,
        headers={"User-Agent": "toplo-monitor/1.0 (personal outage notifier)"},
        timeout=30,
    )
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    # --- ADJUST THESE SELECTORS after inspecting the live DOM. -------------- #
    # This is a best-effort skeleton based on the rendered structure, not the
    # confirmed DOM. Prefer the JSON endpoint from step 1 above.
    outages: list[Outage] = []
    for block in soup.select(".accident-detail, .outage, [data-outage]"):
        header = block.select_one("h2, .title")
        body = block.get_text(" ", strip=True)
        if not header:
            continue
        neighborhood = strip_neighborhood(header.get_text(strip=True))
        rec = None
        m = re.search(r"(?:Expected recovery on|Очаквано възстановяване на)\s*(.+)$", body)
        if m:
            rec = m.group(1).strip()
        outages.append(Outage(neighborhood=neighborhood, area_text=body, recovery=rec))
    return outages


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
    head = "✅ RESOLVED" if resolved else f"⚠️ {record['tier'].upper()}"
    lines = [
        f"{head} — {record['label']}",
        f"Neighborhood: {record['neighborhood']}",
        f"Area: {record['area_text']}",
    ]
    if not resolved:
        lines.append(f"Why: {record['reason']}")
        if record.get("recovery"):
            lines.append(f"Expected back: {record['recovery']}")
    return "\n".join(lines)


def notify_telegram(text: str) -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not (token and chat_id):
        return
    import requests
    requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True},
        timeout=30,
    )


def notify_email(subject: str, text: str) -> None:
    host = os.environ.get("SMTP_HOST")
    if not host:
        return
    import smtplib
    from email.mime.text import MIMEText

    msg = MIMEText(text, _charset="utf-8")
    msg["Subject"] = subject
    msg["From"] = os.environ.get("EMAIL_FROM", os.environ.get("SMTP_USER", ""))
    msg["To"] = os.environ.get("EMAIL_TO", "")

    port = int(os.environ.get("SMTP_PORT", "587"))
    with smtplib.SMTP(host, port, timeout=30) as s:
        s.starttls()
        user, pw = os.environ.get("SMTP_USER"), os.environ.get("SMTP_PASS")
        if user and pw:
            s.login(user, pw)
        s.send_message(msg)


def notify_webhook(payload: dict) -> None:
    url = os.environ.get("WEBHOOK_URL")
    if not url:
        return
    import requests
    requests.post(url, json=payload, timeout=30)


def dispatch(new_alerts: list[dict], resolved: list[dict]) -> None:
    if not new_alerts and not resolved:
        print("No changes since last run.")
        return

    sections = []
    sections += [_format_alert(r) for r in new_alerts]
    sections += [_format_alert(r, resolved=True) for r in resolved]
    text = "\n\n".join(sections)
    subject = f"toplo: {len(new_alerts)} new, {len(resolved)} resolved"

    # Fire each channel independently; one failing must not block the others.
    for fn, args in (
        (notify_telegram, (text,)),
        (notify_email, (subject, text)),
        (notify_webhook, ({"new": new_alerts, "resolved": resolved},)),
    ):
        try:
            fn(*args)
        except Exception as e:  # noqa: BLE001
            print(f"notifier {fn.__name__} failed: {e}", file=sys.stderr)

    print(text)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def main() -> int:
    addresses = load_addresses()
    state = load_state()
    outages = fetch_raw_outages()
    results = evaluate(addresses, outages)
    new_alerts, resolved, new_active = diff(state.get("active", {}), results)
    dispatch(new_alerts, resolved)
    state["active"] = new_active
    state["last_run"] = datetime.now(timezone.utc).isoformat()
    save_state(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

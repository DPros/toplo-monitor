# toplo-monitor

Watches [Toplofikatsia Sofia's outage page](https://toplo.bg/accidents-and-maintenance)
and notifies you (Telegram + email + webhook) when one of your addresses is — or
might be — affected by a hot-water / heating cut. Runs for free on GitHub
Actions on a schedule.

## How it works

```
fetch  ->  parse  ->  match (per address, with confidence tier)  ->  diff vs last run  ->  notify
```

State lives in `state.json`, committed back to the repo each run, so you are
notified **once** when an outage appears and once when it clears — never spammed.

### Confidence tiers

Outages are described in incompatible ways, so matching is not boolean:

| Tier | Meaning |
|------|---------|
| `affected` | Your `lat`/`lng` falls **inside the outage polygon**, or (no coords) whole-neighborhood outage / your block listed / your street + house number listed. |
| `likely`   | Your street is named but without house numbers. |
| `possible` | Right neighborhood, area defined "between streets", and we have no coordinates to resolve it — **verify the boundary yourself**. |
| `clear`    | Outside the outage polygon, different neighborhood, or not affected (no notification). |

You get notified for `possible` and above. When an address has `lat`/`lng` and
the outage carries geometry, the polygon is authoritative: containment decides
`affected` vs `clear` and the text heuristics are skipped.

### Accidents, planned repairs, active & upcoming

The page lists both **accidents** (`Type 0`) and **planned maintenance**
(`Type 1`), and both currently-active and future-dated outages — all are
monitored. Each alert is tagged so you can tell them apart:

```
⚠️ AFFECTED · Planned · UPCOMING — Home
Starts: 2026-06-26T14:00:00Z
Expected back: 2026-06-26T20:00:00Z
```

- **`Accident` / `Planned`** — the outage type.
- **`ACTIVE` / `UPCOMING`** — `UPCOMING` means a planned cut that hasn't started
  yet, so you're warned ahead of time.
- Outages whose window has already ended are dropped, and surface once as
  `✅ RESOLVED`. Times are local Sofia time (EET/EEST).

## Setup

1. Create a **public** repo (Actions minutes are free for public repos) and add these files.
2. Edit `addresses.json`. The `neighborhood` value **must match how toplo.bg
   names it** (in Bulgarian, e.g. `Борово`, `Банишора`) because matching keys off it.
   Fill `block` for block-style neighborhoods (e.g. Mladost), `street` +
   `house_number` otherwise. Set `lat`/`lng` to get **exact point-in-polygon
   matching** — strongly recommended, as the site gives precise geometry per
   outage and it eliminates the fuzzy `possible` guesses.
3. Add notification secrets under **Settings → Secrets and variables → Actions**
   (only set the channels you want — empty ones are skipped):
   - Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
   - Email (SMTP): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_TO`
   - Webhook: `WEBHOOK_URL`
4. Trigger a manual run from the **Actions** tab (`workflow_dispatch`) to test.

### Telegram in 60 seconds
Message `@BotFather` → `/newbot` → copy the token. Then message your new bot
once, open `https://api.telegram.org/bot<TOKEN>/getUpdates`, and read your
`chat.id` from the response.

## How fetching works

No browser automation or API reverse-engineering needed: the page renders one
`var info = {…}` block per outage straight into the HTML (inside an inline
`<script>` comment). Each block carries `Name`, `Region` (the neighborhood),
`Addresses` (the area text), `FromDate`/`UntilDate`, `Type`, and a GeoJSON
`GeolocationSerialized` polygon. `fetch_raw_outages()` does a single GET and
hands the HTML to `parse_outages_html()`, which locates each block and lets the
JSON decoder consume exactly one object (robust to the braces inside the
serialized geometry). The polygon feeds point-in-polygon matching.

`parse_outages_html()` is pure, so it's unit-tested against the real embedded
shape without any network access.

## Good to know

- **Cloudflare Turnstile** protects the site. Plain HTTP fetches currently work
  for this public page; if you ever get blocked, switch the GET in
  `fetch_raw_outages()` to Playwright — `parse_outages_html()` stays unchanged.
- Scrape the **Bulgarian** page (`/accidents-and-maintenance`) — it's canonical;
  the English page often leaves descriptions in Bulgarian anyway.
- Times shown are **local Sofia time** (EET/EEST).
- Be a good citizen: the default 3-hour cadence is gentle. Lower it only a little.
- `match_address()` is pure and unit-tested in `test_logic.py` (run `python test_logic.py`).

## Files

| File | Purpose |
|------|---------|
| `toplo_monitor.py` | All logic: fetch, parse, match, diff, notify. |
| `addresses.json`   | Your monitored addresses. |
| `state.json`       | Auto-created/updated; dedup state. |
| `test_logic.py`    | Tests for parsing & matching against real strings. |
| `.github/workflows/monitor.yml` | Scheduled run + state commit-back. |

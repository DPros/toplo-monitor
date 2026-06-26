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
| `affected` | Whole-neighborhood outage, your block listed, or your street + house number listed. |
| `likely`   | Your street is named but without house numbers. |
| `possible` | Right neighborhood, but the area is defined "between streets" and can't be resolved from text — **verify the boundary yourself**. |
| `clear`    | Different neighborhood / not affected (no notification). |

You get notified for `possible` and above.

## Setup

1. Create a **public** repo (Actions minutes are free for public repos) and add these files.
2. Edit `addresses.json`. The `neighborhood` value **must match how toplo.bg
   names it** (in Bulgarian, e.g. `Борово`, `Банишора`) because matching keys off it.
   Fill `block` for block-style neighborhoods (e.g. Mladost), `street` +
   `house_number` otherwise. `lat`/`lng` are optional today and reserved for
   polygon matching later.
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

## The one thing you must finalize: `fetch_raw_outages()`

I can see the site's rendered text but not its live DOM or map data endpoint, so
the fetcher is left as the integration point.

**Best path (do this once):** open the page, click the **Map** tab, open your
browser's Network panel, and find the XHR/fetch that returns JSON/GeoJSON for
the markers. That payload almost certainly includes neighborhood, description,
times, and **coordinates** per outage. Point `fetch_raw_outages()` at it and map
its fields onto the `Outage` dataclass. If it gives polygon geometry, you can
upgrade the `possible` tier to exact point-in-polygon matching using each
address's `lat`/`lng`.

**Fallback:** the included HTML parser is a skeleton — confirm the real tags/
classes in your browser and adjust the CSS selectors in `fetch_raw_outages()`.

## Good to know

- **Cloudflare Turnstile** protects the site. Plain HTTP fetches may work for
  this public page; if you get blocked, switch the fetcher to Playwright.
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

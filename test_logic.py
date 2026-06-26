"""Quick checks against the actual strings seen on toplo.bg (25 Jun 2026)."""
import json
from datetime import datetime, timedelta, timezone
from toplo_monitor import (
    Address, Outage, Tier, Phase, match_address, parse_blocks, parse_streets,
    strip_neighborhood, is_whole_neighborhood, is_polygon,
    point_in_polygon, rings_from_geojson, parse_outages_html,
    outage_phase, _format_alert,
)

def check(name, got, want):
    ok = got == want
    print(f"[{'OK ' if ok else 'FAIL'}] {name}: got={got!r} want={want!r}")
    return ok

passed = True

# --- neighborhood header stripping ---
passed &= check("strip 'Part of Borovo'", strip_neighborhood("Part of Borovo"), "Borovo")
passed &= check("strip 'Част от Борово'", strip_neighborhood("Част от Борово"), "Борово")
passed &= check("strip 'Zaharna fabrika'", strip_neighborhood("Zaharna fabrika"), "Zaharna fabrika")

# --- block parsing ---
passed &= check("blocks 206 list", parse_blocks("бл.206 вх. 8, 9, 10, бл.206А, бл.207А"),
                {"206", "206А", "207А"})
passed &= check("blocks chained", parse_blocks("Бл.14,15,16 и 17."), {"14", "15", "16", "17"})
passed &= check("blocks poligona", parse_blocks("бл.40, 43, 44, 45, 55, 56, 57."),
                {"40", "43", "44", "45", "55", "56", "57"})

# --- street parsing ---
streets = dict(parse_streets('ул."Коста Лулчев" №27 ДЕО (ИЧС).'))
passed &= check("street Kosta Lulchev num", streets.get("коста лулчев"), {"27"})

# --- whole-neighborhood / polygon detection ---
passed &= check("whole nbhd EN", is_whole_neighborhood("the whole neighborhood"), True)
passed &= check("whole nbhd BG целия", is_whole_neighborhood("целия квартал"), True)
passed &= check("whole nbhd BG целият (live)", is_whole_neighborhood("целият квартал"), True)
passed &= check("not whole nbhd", is_whole_neighborhood('ул."Костур"'), False)
passed &= check("polygon BG", is_polygon('в участъка между бул."Гоце Делчев", ул."Ястребец"'), True)

# --- end-to-end matching scenarios ---
# 1) Borovo polygon outage vs an address on Topli dol in Borovo -> POSSIBLE
borovo = Outage(neighborhood="Borovo",
                area_text='в участъка: бул."Гоце Делчев", ул."Ястребец", ул."Борово", бул."България"')
addr_topli = Address(label="Topli dol", neighborhood="Borovo", street="Топли дол", house_number="1а")
tier, reason = match_address(addr_topli, borovo)
passed &= check("Borovo polygon -> POSSIBLE", tier, Tier.POSSIBLE)

# 2) Banishora address vs all the (non-Banishora) outages -> CLEAR
addr_ban = Address(label="Svishtov", neighborhood="Banishora", street="Свищов", house_number="4")
center = Outage(neighborhood="Center", area_text="между бул. Патриарх Евтимий ...")
tier, _ = match_address(addr_ban, center)
passed &= check("Banishora vs Center -> CLEAR", tier, Tier.CLEAR)

# 3) Whole-neighborhood outage matches any address in it -> AFFECTED
zf = Outage(neighborhood="Zaharna fabrika", area_text="the whole neighborhood")
addr_zf = Address(label="ZF", neighborhood="Zaharna fabrika", street="x", house_number="1")
tier, _ = match_address(addr_zf, zf)
passed &= check("Whole neighborhood -> AFFECTED", tier, Tier.AFFECTED)

# 4) Block listed and matches -> AFFECTED
mladost = Outage(neighborhood="Mladost 2", area_text="бл.206 вх. 8, 9, 10, бл.206А, бл.207А")
addr_blk = Address(label="206A", neighborhood="Mladost 2", block="206А")
tier, _ = match_address(addr_blk, mladost)
passed &= check("Block listed -> AFFECTED", tier, Tier.AFFECTED)

# 5) Street + house number exactly listed -> AFFECTED
geo = Outage(neighborhood="Geo Milev", area_text='ул."Коста Лулчев" №27')
addr_kl = Address(label="KL27", neighborhood="Geo Milev", street="Коста Лулчев", house_number="27")
tier, _ = match_address(addr_kl, geo)
passed &= check("Street+number -> AFFECTED", tier, Tier.AFFECTED)

# --- geometry: point-in-polygon (vertices are (lng, lat)) ---
square = [(23.264, 42.717), (23.266, 42.717), (23.266, 42.718), (23.264, 42.718), (23.264, 42.717)]
passed &= check("pip inside", point_in_polygon(23.265, 42.7175, square), True)
passed &= check("pip outside", point_in_polygon(23.30, 42.70, square), False)
passed &= check("pip degenerate ring", point_in_polygon(0.0, 0.0, [(0.0, 0.0), (1.0, 1.0)]), False)

# --- geometry: parse the real GeoJSON shape (array of Features, doubled pts) ---
_geo = ('[{"type":"Feature","properties":{},"geometry":{"type":"Polygon",'
        '"coordinates":[[[23.264,42.717],[23.266,42.717],[23.266,42.718],'
        '[23.264,42.718],[23.264,42.717]]]}}]')
_rings = rings_from_geojson(_geo)
passed &= check("rings parsed", len(_rings), 1)
passed &= check("ring vertex is (lng,lat)", _rings[0][0], (23.264, 42.717))
passed &= check("rings of empty", rings_from_geojson(None), [])

# --- end-to-end: extract a `var info = {…}` block exactly as the page embeds it ---
_info = {
    "AccidentId": "abc", "Name": "Част от Люлин 9", "Addresses": "Бл.906,907.",
    "GeolocationSerialized": _geo, "Type": 0,
    "FromDate": "2026-06-26T14:00:00Z", "UntilDate": "2026-06-26T20:00:00Z",
    "Region": "Люлин 9",
}
SAMPLE = ("<script>(function parseAll(){ <!--\n var info = "
          + json.dumps(_info, ensure_ascii=False)
          + "\n if (x) {} --> })()</script>")
outs = parse_outages_html(SAMPLE)
passed &= check("parsed one outage", len(outs), 1)
passed &= check("parsed Region as neighborhood", outs[0].neighborhood, "Люлин 9")
passed &= check("parsed area text", outs[0].area_text, "Бл.906,907.")
passed &= check("parsed start", outs[0].start, "2026-06-26T14:00:00Z")
passed &= check("parsed polygon", len(outs[0].polygons), 1)

# de-dup on AccidentId when the same block appears twice
passed &= check("dedupe by AccidentId", len(parse_outages_html(SAMPLE + SAMPLE)), 1)

# --- geometry beats text: address coords decide AFFECTED vs CLEAR ---
addr_in = Address(label="in", neighborhood="Люлин 9", lat=42.7175, lng=23.265)
tier, _ = match_address(addr_in, outs[0])
passed &= check("inside polygon -> AFFECTED", tier, Tier.AFFECTED)

addr_out = Address(label="out", neighborhood="Люлин 9", lat=42.70, lng=23.30)
tier, _ = match_address(addr_out, outs[0])
passed &= check("outside polygon -> CLEAR", tier, Tier.CLEAR)

# without coords we still fall back to the text matcher (block listed -> AFFECTED)
addr_blk906 = Address(label="906", neighborhood="Люлин 9", block="906")
tier, _ = match_address(addr_blk906, outs[0])
passed &= check("no coords -> text fallback AFFECTED", tier, Tier.AFFECTED)

# --- phase: active accidents AND future planned repairs are both kept ---
_NOW = datetime(2026, 6, 26, 13, 0, tzinfo=timezone.utc)
def _iso(dt): return dt.strftime("%Y-%m-%dT%H:%M:%SZ")

active = Outage(neighborhood="X", area_text="",
                start=_iso(_NOW - timedelta(hours=2)), recovery=_iso(_NOW + timedelta(hours=2)))
upcoming = Outage(neighborhood="X", area_text="", kind="repairs",
                  start=_iso(_NOW + timedelta(hours=5)), recovery=_iso(_NOW + timedelta(hours=9)))
ended = Outage(neighborhood="X", area_text="",
               start=_iso(_NOW - timedelta(days=2)), recovery=_iso(_NOW - timedelta(hours=1)))
passed &= check("phase active", outage_phase(active, _NOW), Phase.ACTIVE)
passed &= check("phase upcoming (planned)", outage_phase(upcoming, _NOW), Phase.UPCOMING)
passed &= check("phase ended", outage_phase(ended, _NOW), Phase.ENDED)
passed &= check("phase no dates -> active", outage_phase(Outage("X", ""), _NOW), Phase.ACTIVE)

# --- alert text surfaces type + timing so planned/upcoming is distinguishable ---
planned_rec = {"label": "Home", "tier": "affected", "reason": "inside polygon",
               "neighborhood": "Люлин 9", "area_text": "Бл.906", "kind": "repairs",
               "phase": Phase.UPCOMING, "start": "2026-06-26T14:00:00Z",
               "recovery": "2026-06-26T20:00:00Z"}
msg = _format_alert(planned_rec)
passed &= check("alert tags planned+upcoming", ("Planned" in msg and "UPCOMING" in msg), True)
passed &= check("alert shows start time", "Starts: 2026-06-26T14:00:00Z" in msg, True)

print("\nALL PASSED" if passed else "\nSOME FAILED")
raise SystemExit(0 if passed else 1)

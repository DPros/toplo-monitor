"""Quick checks against the actual strings seen on toplo.bg (25 Jun 2026)."""
from toplo_monitor import (
    Address, Outage, Tier, match_address, parse_blocks, parse_streets,
    strip_neighborhood, is_whole_neighborhood, is_polygon,
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

print("\nALL PASSED" if passed else "\nSOME FAILED")
raise SystemExit(0 if passed else 1)

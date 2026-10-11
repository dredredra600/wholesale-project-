#!/usr/bin/env python3
"""El Paso Lead Scout: filter, score, dedupe and merge DealMachine records.

DealMachine does the searching; this script applies the rules DealMachine
cannot (exact city limits with holes, "any one signal", unknown-value
handling), scores leads, and maintains data/lists/el-paso-leads.json.

Subcommands
  candidates  Normalize raw DealMachine search/get_many JSON files, apply the
              buy box + signals, drop leads already on the dashboard, score,
              and write the top N to a candidates file.
  merge       Combine candidates with comps and skip-trace results and append
              them to the dashboard data file (max 50 new per run).
  recheck     Re-evaluate existing leads against fresh records and mark the
              ones that no longer match the buy box.

Never invents data: anything DealMachine did not return stays null and the
dashboard shows it as "not available".
"""
import argparse
import json
import os
import sys
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOUNDARY = os.path.join(ROOT, "data", "geo", "el-paso-city-limits.geojson")
LEADS = os.path.join(ROOT, "data", "lists", "el-paso-leads.json")
MAX_NEW = 50
# Dates (date_added, last_checked, years owned) are El Paso local dates.
LOCAL_TZ = ZoneInfo("America/Denver")


def local_today():
    return datetime.now(LOCAL_TZ).date()

BUY_BOX = {
    "property_type": "Single Family",
    "max_year_built": 2000,
    "min_beds": 3,
    "min_baths": 1,
    "min_equity_pct": 40,
    "min_value": 100_000,
    "max_value": 300_000,
}


# ---------- geography ----------

def _load_rings():
    with open(BOUNDARY) as f:
        gj = json.load(f)
    geom = gj["features"][0]["geometry"]
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return polys


def _in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


_POLYS = None


def in_city_limits(lat, lng):
    """True when the point is inside the Census El Paso city boundary
    (GEOID 4824000), honoring the holes that are not part of the city."""
    global _POLYS
    if lat is None or lng is None:
        return None
    if _POLYS is None:
        _POLYS = _load_rings()
    for poly in _POLYS:
        if _in_ring(lng, lat, poly[0]) and not any(_in_ring(lng, lat, h) for h in poly[1:]):
            return True
    return False


# ---------- normalization ----------

def _yes(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("yes", "true", "1")


def _date(v):
    if not v:
        return None
    return str(v)[:10]


def years_between(d, today):
    if not d:
        return None
    y, m, dd = (int(p) for p in d.split("-"))
    yrs = today.year - y - ((today.month, today.day) < (m, dd))
    return yrs


def normalize(rec, today):
    """Map a DealMachine property record (search or get_many shape) to a lead."""
    sale = _date(rec.get("last_sale_date"))
    sale_price = rec.get("last_sale_price", rec.get("last_sale_amount"))
    yrs = years_between(sale, today)
    owners = [n for n in (rec.get("owner_1_full_name"), rec.get("owner_2_full_name")) if n]
    lat, lng = rec.get("latitude"), rec.get("longitude")
    absentee = _yes(rec.get("has_absentee_owners"))
    if absentee is None and rec.get("owner_occupied") is not None:
        absentee = not rec["owner_occupied"]
    addr = rec.get("address")
    if addr and rec.get("unit"):
        addr = f"{addr} {rec['unit']}"
    return {
        "dm_property_id": rec["dm_property_id"],
        "address": addr,
        "city": rec.get("city"),
        "state": rec.get("state"),
        "zip": rec.get("zip"),
        "full_address": rec.get("full_address"),
        "latitude": lat,
        "longitude": lng,
        "in_city_limits": in_city_limits(lat, lng),
        "property_type": rec.get("property_type"),
        "beds": rec.get("num_bedrooms"),
        "baths": rec.get("num_bathrooms"),
        "sqft": rec.get("living_area_sqft"),
        "year_built": rec.get("year_built"),
        "apn": rec.get("parcel_number_raw", rec.get("apn")),
        "owners": owners,
        "owner_mailing_address": None,
        "absentee": absentee,
        "out_of_state_owner": _yes(rec.get("has_out_of_state_owners")),
        "estimated_value": rec.get("estimated_value"),
        "equity_pct": rec.get("estimated_equity_percentage"),
        "equity_amount": rec.get("estimated_equity_amount"),
        "last_sale_date": sale,
        # DealMachine reports $0 for non-arm's-length transfers; that is a real value, keep it.
        "last_sale_price": sale_price,
        "signals": {
            "tax_delinquent": _yes(rec.get("is_tax_delinquent")) or False,
            "tax_delinquent_year": rec.get("tax_delinquent_year") if _yes(rec.get("is_tax_delinquent")) else None,
            "vacant": _yes(rec.get("is_vacant_home")) or False,
            "years_owned": yrs,
            "long_term_owned": yrs is not None and yrs >= 10,
        },
    }


# ---------- rules ----------

def buy_box_failures(lead):
    """List of reasons a lead fails the buy box. Unknown values fail, since
    the rule cannot be confirmed."""
    b = BUY_BOX
    f = []
    if lead["in_city_limits"] is not True:
        f.append("outside El Paso city limits" if lead["in_city_limits"] is False else "location not available")
    if lead["property_type"] != b["property_type"]:
        f.append(f"property type {lead['property_type'] or 'not available'}")
    if lead["year_built"] is None or lead["year_built"] > b["max_year_built"]:
        f.append(f"year built {lead['year_built'] or 'not available'}")
    if lead["beds"] is None or lead["beds"] < b["min_beds"]:
        f.append(f"beds {lead['beds'] if lead['beds'] is not None else 'not available'}")
    if lead["baths"] is None or lead["baths"] < b["min_baths"]:
        f.append(f"baths {lead['baths'] if lead['baths'] is not None else 'not available'}")
    if lead["equity_pct"] is None or lead["equity_pct"] < b["min_equity_pct"]:
        f.append(f"equity {lead['equity_pct'] if lead['equity_pct'] is not None else 'not available'}%")
    v = lead["estimated_value"]
    if v is None or not (b["min_value"] <= v <= b["max_value"]):
        f.append(f"value {v if v is not None else 'not available'}")
    s = lead["signals"]
    if not (s["tax_delinquent"] or s["vacant"] or s["long_term_owned"]):
        f.append("no motivation signal")
    return f


def score(lead):
    e = lead["equity_pct"] or 0
    s = lead["signals"]
    eq = 40 if e >= 90 else 32 if e >= 70 else 25 if e >= 50 else 15 if e >= 40 else 0
    yrs = s["years_owned"]
    yo = 15 if yrs is not None and yrs >= 20 else 10 if yrs is not None and yrs >= 10 else 0
    bd = {
        "equity": eq,
        "tax_delinquent": 25 if s["tax_delinquent"] else 0,
        "vacant": 20 if s["vacant"] else 0,
        "years_owned": yo,
    }
    return max(1, min(100, sum(bd.values()))), bd


def sort_key(lead):
    # Highest score first; ties broken by equity dollars, then longest ownership.
    return (-lead["score"], -(lead["equity_amount"] or 0), -(lead["signals"]["years_owned"] or 0))


# ---------- io ----------

def load_records(paths):
    recs = {}
    for p in paths:
        with open(p) as f:
            d = json.load(f)
        if isinstance(d, list) and d and isinstance(d[0], dict) and "text" in d[0]:
            d = json.loads(d[0]["text"])
        for r in d.get("data", []):
            if r.get("found") is False:
                continue
            pid = r["dm_property_id"]
            recs[pid] = {**recs.get(pid, {}), **{k: v for k, v in r.items() if v is not None}}
    return recs


def load_leads():
    if not os.path.exists(LEADS):
        return {"list": "El Paso Lead Scout", "last_refreshed": None, "runs": [], "leads": []}
    with open(LEADS) as f:
        return json.load(f)


def save_leads(data):
    data["leads"].sort(key=lambda l: (l.get("status") != "active", *sort_key(l)))
    with open(LEADS, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


# ---------- commands ----------

def cmd_candidates(a):
    today = date.fromisoformat(a.today) if a.today else local_today()
    existing = {l["dm_property_id"] for l in load_leads()["leads"]}
    skip = set(a.exclude or [])
    recs = load_records(a.files)
    kept, dropped = [], {}
    for pid, r in recs.items():
        lead = normalize(r, today)
        if pid in existing:
            dropped[pid] = ["already on dashboard"]
            continue
        if pid in skip:
            dropped[pid] = ["already a DealMachine prospect"]
            continue
        fails = buy_box_failures(lead)
        if fails:
            dropped[pid] = fails
            continue
        lead["score"], lead["score_breakdown"] = score(lead)
        kept.append(lead)
    kept.sort(key=sort_key)
    top = kept[: a.limit]
    out = {"generated": today.isoformat(), "pulled": len(recs), "eligible": len(kept),
           "dropped": dropped, "candidates": top}
    with open(a.out, "w") as f:
        json.dump(out, f, indent=2)
    print(f"pulled {len(recs)}  eligible {len(kept)}  dropped {len(dropped)}  kept {len(top)}")
    reasons = {}
    for rs in dropped.values():
        for r in rs:
            k = r.split(" ")[0] if not r.startswith(("outside", "no ", "already")) else r
            reasons[k] = reasons.get(k, 0) + 1
    for k, v in sorted(reasons.items(), key=lambda x: -x[1]):
        print(f"  drop: {k} x{v}")


def _comp_summary(entry):
    """ARV from recent nearby sold single-family comps: median sold $/sqft
    times subject sqft. Returns None fields when no usable comps."""
    comps = []
    for c in entry.get("comps", []):
        price, sqft = c.get("sale_price"), c.get("sqft")
        if price and sqft:
            comps.append({**c, "ppsf": price / sqft})
    if not comps:
        return {"value": None, "comp_count": 0, "date_from": None, "date_to": None, "comps": entry.get("comps", [])}
    ppsf = sorted(c["ppsf"] for c in comps)
    n = len(ppsf)
    med = ppsf[n // 2] if n % 2 else (ppsf[n // 2 - 1] + ppsf[n // 2]) / 2
    dates = sorted(c["sale_date"] for c in comps if c.get("sale_date"))
    subj_sqft = entry.get("subject_sqft")
    return {
        "value": round(med * subj_sqft / 1000) * 1000 if subj_sqft else None,
        "median_ppsf": round(med, 2),
        "comp_count": n,
        "date_from": dates[0] if dates else None,
        "date_to": dates[-1] if dates else None,
        "method": "median sold $/sqft of comps x subject sqft",
        "comps": [{k: v for k, v in c.items() if k != "ppsf"} for c in comps],
    }


def _json_or_text(v):
    if v is None:
        return None
    try:
        return json.loads(v)
    except ValueError:
        return v


def cmd_merge(a):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    today = a.today or local_today().isoformat()
    with open(a.candidates) as f:
        cand = json.load(f)["candidates"]
    comps = json.load(open(a.comps)) if a.comps else {}
    contacts = json.load(open(a.contacts)) if a.contacts else {}
    data = load_leads()
    have = {l["dm_property_id"] for l in data["leads"]}
    added = []
    for lead in cand:
        if lead["dm_property_id"] in have or len(added) >= MAX_NEW:
            continue
        pid = lead["dm_property_id"]
        lead["arv"] = _comp_summary(comps[pid]) if pid in comps else None
        ct = contacts.get(pid)
        lead["phones"] = ct["phones"] if ct else []
        lead["emails"] = ct["emails"] if ct else []
        if ct and ct.get("owner_mailing_address"):
            lead["owner_mailing_address"] = ct["owner_mailing_address"]
        lead["skip_trace_people"] = ct.get("people", []) if ct else []
        lead["skip_traced"] = bool(ct)
        lead["date_added"] = today
        lead["last_checked"] = today
        lead["status"] = "active"
        data["leads"].append(lead)
        added.append(lead)
    data["last_refreshed"] = now.isoformat().replace("+00:00", "Z")
    run = {
        "run_at": data["last_refreshed"],
        "new_leads": len(added),
        "credits": json.loads(a.credits) if a.credits else None,
        "total_matches": json.loads(a.matches) if a.matches else None,
        "dealmachine_list": _json_or_text(a.dm_list),
        "notes": _json_or_text(a.notes),
    }
    data["runs"].append(run)
    if a.search_state:
        data["search_state"] = json.loads(a.search_state)
    save_leads(data)
    print(f"added {len(added)}; total leads {len(data['leads'])}")


def cmd_recheck(a):
    today = date.fromisoformat(a.today) if a.today else local_today()
    recs = load_records(a.files)
    data = load_leads()
    changed = 0
    for l in data["leads"]:
        r = recs.get(l["dm_property_id"])
        if not r:
            continue
        fresh = normalize(r, today)
        # get_many records omit some fields (property type, signal flags):
        # only overwrite what this record actually carries.
        for k in ("estimated_value", "equity_pct", "equity_amount", "beds", "baths", "sqft",
                  "year_built", "property_type", "last_sale_date", "last_sale_price"):
            if fresh[k] is not None:
                l[k] = fresh[k]
        s = l["signals"]
        if "is_tax_delinquent" in r:
            s["tax_delinquent"] = fresh["signals"]["tax_delinquent"]
            s["tax_delinquent_year"] = fresh["signals"]["tax_delinquent_year"]
        if "is_vacant_home" in r:
            s["vacant"] = fresh["signals"]["vacant"]
        s["years_owned"] = years_between(l["last_sale_date"], today)
        s["long_term_owned"] = s["years_owned"] is not None and s["years_owned"] >= 10
        fails = buy_box_failures(l)
        l["last_checked"] = today.isoformat()
        l["score"], l["score_breakdown"] = score(l)
        if fails and l.get("status") != "no_longer_matching":
            l["status"], l["no_longer_matching_reasons"] = "no_longer_matching", fails
            changed += 1
        elif not fails and l.get("status") == "no_longer_matching":
            l["status"] = "active"
            l.pop("no_longer_matching_reasons", None)
            changed += 1
    save_leads(data)
    print(f"rechecked {sum(1 for l in data['leads'] if l['dm_property_id'] in recs)}; status changes {changed}")


def _load_payload(p):
    with open(p) as f:
        d = json.load(f)
    if isinstance(d, list) and d and isinstance(d[0], dict) and "text" in d[0]:
        d = json.loads(d[0]["text"])
    return d


def cmd_comps(a):
    """Raw dealmachine_comps outputs -> {property_id: {subject_sqft, comps[]}}."""
    out = {}
    for p in a.files:
        for e in _load_payload(p).get("data", []):
            if not e.get("found"):
                continue
            out[e["dm_property_id"]] = {
                "subject_sqft": (e.get("subject") or {}).get("sqft"),
                "comps": [{
                    "address": (c.get("display_line_1") or c.get("address") or "")
                               + (", " + c["display_line_2"] if c.get("display_line_2") else ""),
                    "dm_property_id": c.get("dm_property_id"),
                    "sale_price": c.get("sale_price"),
                    "sale_date": (c.get("sale_date") or "")[:10] or None,
                    "sale_type": c.get("sale_type"),
                    "sqft": c.get("sqft"), "beds": c.get("bedrooms"), "baths": c.get("bathrooms"),
                    "year_built": c.get("year_built"), "distance_mi": c.get("distance"),
                    "match": (c.get("match_score") or {}).get("overall"),
                } for c in e.get("comps", []) if c.get("type") == "sale"],
            }
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1)
    print(f"comps for {len(out)} subjects")


def cmd_contacts(a):
    """Skip-trace results -> {property_id: {people, phones, emails, owner_mailing_address}}.

    Accepts raw dealmachine_property_get_many outputs (contact_audience=owners)
    or the compact transcription {property_id: [{name, is_resident, residence,
    phones: [[number, type, do_not_call]], emails: [..]}]}.
    """
    raw = {}
    for p in a.files:
        d = _load_payload(p)
        if "data" in d:
            for r in d["data"]:
                if r.get("found") is False:
                    continue
                raw[r["dm_property_id"]] = [{
                    "name": c.get("full_name"),
                    "is_resident": c.get("is_resident"),
                    "residence": (c.get("residence") or {}).get("full_address"),
                    "phones": [[ph["number"], ph.get("type"), bool(ph.get("do_not_call"))] for ph in c.get("phones", [])],
                    "emails": [e["address"] for e in c.get("emails", [])],
                } for c in r.get("contacts", [])]
        else:
            raw.update(d)
    out = {}
    for pid, cs in raw.items():
        phones, emails, mail, people = {}, [], None, []
        for c in cs:
            people.append({"name": c["name"], "is_resident": c["is_resident"], "residence": c["residence"]})
            for n, t, dnc in c["phones"]:
                ph = phones.setdefault(n, {"number": n, "type": t, "do_not_call": dnc, "owners": []})
                ph["do_not_call"] = ph["do_not_call"] or dnc
                if c["name"] not in ph["owners"]:
                    ph["owners"].append(c["name"])
            for e in c["emails"]:
                if e.lower() not in emails:
                    emails.append(e.lower())
            if c["is_resident"] is False and not mail and c["residence"]:
                mail = c["residence"] + " (skip-trace residence)"
        out[pid] = {"people": people, "phones": list(phones.values()), "emails": emails, "owner_mailing_address": mail}
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1)
    print(f"contacts for {len(out)} properties; {sum(1 for v in out.values() if v['people'])} with owners found")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("candidates")
    c.add_argument("files", nargs="+")
    c.add_argument("--out", required=True)
    c.add_argument("--limit", type=int, default=MAX_NEW)
    c.add_argument("--exclude", nargs="*", help="DealMachine property IDs to skip (existing prospects)")
    c.add_argument("--today")
    m = sub.add_parser("merge")
    m.add_argument("candidates")
    m.add_argument("--comps")
    m.add_argument("--contacts")
    m.add_argument("--credits", help='JSON, e.g. {"properties":150,"people":55}')
    m.add_argument("--matches", help="JSON of total match counts")
    m.add_argument("--dm-list")
    m.add_argument("--notes")
    m.add_argument("--search-state", help="JSON: next page to pull per signal search")
    m.add_argument("--today")
    r = sub.add_parser("recheck")
    r.add_argument("files", nargs="+")
    r.add_argument("--today")
    for name in ("comps", "contacts"):
        s = sub.add_parser(name)
        s.add_argument("files", nargs="+")
        s.add_argument("--out", required=True)
    a = p.parse_args()
    {"candidates": cmd_candidates, "merge": cmd_merge, "recheck": cmd_recheck,
     "comps": cmd_comps, "contacts": cmd_contacts}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())

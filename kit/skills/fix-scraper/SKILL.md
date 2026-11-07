---
name: fix-scraper
description: Diagnose and fix broken or incomplete scraper adapters. Audit existing adapters for coverage gaps, test endpoints live, fix data extraction issues, and bring adapters to Gold+ standard.
---

# Fix Scraper — Adapter Diagnosis and Repair Protocol

You are fixing or upgrading an existing county scraper adapter for CompRedux. This skill focuses on diagnosing why data is missing, testing endpoints live, fixing extraction gaps, and closing the gap to Gold+.

**Invoke with:** `/fix-scraper <county-name>` or `/fix-scraper all` for a full audit

## Gold+ Standard (the target)

Every fix should bring a county closer to Gold+ on the SCRAPER-MASTER.md scorecard:

| # | Dimension | Pass Criteria |
|---|-----------|---------------|
| 1 | Tax Assessment | Dedicated adapter returns current year land/improvement/total |
| 2 | Tax Bill | Dedicated adapter returns tax amount, installments, payment status |
| 3 | Zoning (Unincorporated) | County ArcGIS returns zone code for unincorporated parcels |
| 4 | Zoning (Incorporated) | City config for EVERY incorporated city with CRE activity |
| 5 | APN Format | Tested with 3+ real APNs, parcel lookup succeeds |
| 6 | City Detection | Parcel field, citiesUrl, or brute-force fallback works |
| 7 | Environmental | FEMA + EPA run (automatic) |
| 8 | Zone Standards | All base zone codes seeded in zone_standards table |
| 9 | Sales History | ATTOM returns data for county FIPS |
| 10 | End-to-End Test | 1+ incorporated + 1+ unincorporated APN tested |

**Current Gold+ counties:** San Francisco, Orange, Dallas, Harris, Tarrant, Clark
**Reference:** `docs/SCRAPER-MASTER.md` for full 65-county scorecard

## When to Use This Skill

- A scraper returns empty data for some fields
- Zoning data is missing (likely county vs city GIS gap — the #1 issue)
- ATTOM enrichment is filling fields the scraper should have caught
- A user reports missing data for a specific county/property
- After adding a new adapter, to verify full pipeline works
- Periodic health audit of all scrapers
- Broken URLs causing scrape failures

## Phase 1: Diagnose

### Step 1: Check current grade

```bash
grep '<county-id>' docs/SCRAPER-MASTER.md
```

Identify which Gold+ dimensions are failing.

### Step 2: Check adapter registry

```bash
grep -A10 "'county-id'" server/src/services/scraper/adapterRegistry.js
```

Expected: `tax_assessment` + `tax_bill` adapters. Also check for `zoning` (dedicated or ArcGIS auto-registered via `arcgis-county-configs.js` with `available: true`).

### Step 3: Check city zoning coverage

```bash
grep -A20 "'county-id'" server/src/services/scraper/data/arcgis-city-zoning-configs.js
```

If no entry: ALL incorporated city parcels get empty zoning. This is the most common gap.

Cross-reference with the county's incorporated cities. If major CRE cities are missing configs, that's the fix.

### Step 4: Check APN format

```bash
grep -A15 "'county-id'" server/src/services/scraper/data/arcgis-county-configs.js
```

Verify `parcelsApnFormat` matches what the GIS layer stores. Test with:
```
# Sample 5 APNs from the layer
https://<parcelsUrl>?where=1=1&outFields=APN&resultRecordCount=5&f=json
```

Common APN format bugs:
- `dashes` config but layer stores `nodashes` (Monterey)
- Layer stores fixed-length padded APNs (San Benito: `parcelsApnPadEnd: 10`)
- User enters 4-segment APN but layer only has 3 segments (`parcelsApnStripSegments: 3`)

### Step 5: Check city detection

Does the parcel layer have a city/jurisdiction field? Check `parcelsOutFields` for: `City`, `Juri`, `Jurisdiction`, `SITUS_CITY`, `MUNI_NAME`.

If no city field exists:
- Is `citiesUrl` configured? (spatial query against city boundaries)
- Are city zoning configs present? (brute-force fallback tries each city layer at centroid, max 5)
- Does the address fallback work? (only on re-scrape when address is in DB)

### Step 6: Identify the gap category

| Symptom | Likely Cause | Fix |
|---|---|---|
| Zoning always empty (incorporated) | No city zoning config | Add city config to arcgis-city-zoning-configs.js |
| Zoning always empty (unincorporated) | County ArcGIS broken or not configured | Test zoningUrl, fix or add config |
| "No parcel found" | APN format mismatch | Check parcelsApnFormat, test with real APNs |
| Prior year tax data empty | Normal — only current year auto-fills for free | Users fill via enrichment (credits) |
| Tax amount always empty | Tax on different site than assessor | Need separate tax bill adapter |
| Scrape times out or 301 | URL changed (domain migration) | Update URL in adapter |
| City detection fails silently | Parcel layer has no city field | Add city field to parcelsOutFields, or rely on brute-force |
| Zone standards lookup fails | Zone codes not seeded in DB | Create zone_standards migration |

## Phase 2: Fix

### Fix A: Missing City Zoning (most common)

1. Research ALL incorporated cities in the county
2. For each city, find a public ArcGIS zoning endpoint:
   - City's own GIS portal
   - County-hosted city layers (like San Benito)
   - UC Davis Statewide Zoning layer (fallback)
3. Add entry to `arcgis-city-zoning-configs.js`
4. Test: spatial query at a parcel centroid within the city

### Fix B: APN Format

1. Query the parcel layer for sample APNs: `where=1=1&outFields=APN&resultRecordCount=10`
2. Compare format against config
3. Update `parcelsApnFormat`, add `parcelsApnPadEnd`, `parcelsApnStripSegments`, etc.
4. Test with 3+ APNs including different segment counts

### Fix C: Broken URLs

1. `curl -I <url>` — check for 301 redirects
2. Follow redirects to final URL
3. Update adapter file
4. Test with known APN

### Fix D: Missing Zone Standards

1. Query all zone codes from county + city GIS layers
2. Research municipal code for development standards per zone
3. Create migration to seed `zone_standards` table
4. Test lookup: zone code from GIS → standards from DB

### Fix E: City Detection

If parcel layer has no city field:
1. Check if a city boundaries layer exists (`citiesUrl` with `citiesNameField`)
2. If not: the brute-force fallback handles it (tries each configured city's zoning layer at centroid)
3. Add `Juri`, `City`, or relevant field to `parcelsOutFields` if available
4. Add field name to `cityFields` array in arcgis-zoning.js if it's a non-standard name

## Phase 3: Verify

### Step 1: End-to-End Test

For each jurisdiction (unincorporated + each major city):
```js
// 1. Parcel lookup with APN
// 2. County zoning at centroid (expect empty for incorporated)
// 3. City zoning at centroid (expect zone code for incorporated)
// 4. Zone standards lookup for returned zone code
```

### Step 2: Score Against Gold+ Dimensions

Walk all 10 dimensions. Document pass/fail.

### Step 3: Update SCRAPER-MASTER.md

Update the county's row with the new grade.

### Step 4: Data Completeness Checklist

| Section | Fields | Target |
|---|---|---|
| Tax Assessment (current) | land, improvement, total, tax_amount, exemptions | All 5 |
| Tax Assessment (prior 3yr) | Same fields | Via paid enrichment |
| Zoning (every jurisdiction) | zone_designation + 10 development standards | zone code + standards from DB |
| Property Details | address, owner, lot area, sqft, year built | Via ATTOM auto-fill |
| Environmental | flood zone, flood panel, EPA facilities | Via FEMA + EPA adapters |
| Sales History | sale_date, sale_price, deed_type | Via ATTOM (first free) |

## Key File Paths

| File | Purpose |
|---|---|
| `docs/SCRAPER-MASTER.md` | Gold+ scorecard — check grade, update after fix |
| `server/src/services/scraper/adapterRegistry.js` | ADAPTER_REGISTRY — what's registered |
| `server/src/services/scraper/data/arcgis-county-configs.js` | County ArcGIS configs (parcels + zoning) |
| `server/src/services/scraper/data/arcgis-city-zoning-configs.js` | 164 city zoning configs, 34 counties |
| `server/src/services/scraper/adapters/arcgis-zoning.js` | Generic ArcGIS adapter with city fallback chain |
| `server/src/services/scraper/adapters/base.js` | BaseAdapter helpers |
| `server/src/services/zoneStandardsService.js` | Zone standards lookup (9-strategy fallback) |

## Architecture: City Zoning Fallback Chain

When county zoning returns empty for an incorporated parcel:

1. **Parcel attributes** — Check `cityFields` array (City, Juri, Jurisdiction, SITUS_CITY, etc.)
2. **citiesUrl** — Spatial query against city boundaries polygon layer
3. **Address fallback** — Parse city from report's property_address (re-scrape only)
4. **Brute-force** — Try each configured city's zoning layer at centroid (max 5 cities)

If ALL fail: empty zoning. User sees "No automated source available" in data transparency.

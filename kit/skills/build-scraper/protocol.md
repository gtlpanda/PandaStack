# Skill: Build County Scraper Adapter

Invoked with: `/build-scraper <county-name>`

Build a complete multi-source scraper adapter set for a county, targeting **Gold+** on the SCRAPER-MASTER.md scorecard.

---

## Gold+ Standard (10 dimensions — all must pass)

| # | Dimension | Pass Criteria |
|---|-----------|---------------|
| 1 | **Tax Assessment** | Dedicated adapter returns current year land/improvement/total values |
| 2 | **Tax Bill** | Dedicated adapter returns tax amount, installments, payment status |
| 3 | **Zoning (Unincorporated)** | County ArcGIS layer returns zone code for unincorporated parcels |
| 4 | **Zoning (Incorporated)** | City config exists for EVERY incorporated city with CRE activity. City detection works. |
| 5 | **APN Format** | Tested with 3+ real APNs (3-segment, 4-segment). Parcel lookup succeeds. |
| 6 | **City Detection** | Parcel attributes, citiesUrl spatial query, or brute-force fallback correctly identifies city |
| 7 | **Environmental** | FEMA flood + EPA facilities adapters run (automatic, no config needed) |
| 8 | **Zone Standards** | All base zone codes for county + cities seeded in zone_standards table |
| 9 | **Sales History** | ATTOM returns data for county FIPS (verify with real APN) |
| 10 | **End-to-End Test** | At least 1 incorporated + 1 unincorporated APN tested with full pipeline |

**Reference:** `docs/SCRAPER-MASTER.md` has the full scorecard and per-county status.

---

## Failure Pattern Catalog

### Pattern A: API endpoint names are misleading
Sacramento's `assessmentvaluescurrentyear` returned prior year data. **Never trust an endpoint name. Always inspect the actual response payload with real APNs.**

### Pattern B: Browser-dependent adapters don't deploy
Playwright adapters fail in production (Render) due to Chromium binary size. **Strongly prefer fetch/REST over Playwright. If Playwright is required, document why.**

### Pattern C: Tax amounts and assessed values come from different departments
The assessor and tax collector are different county departments with different websites. **Always identify both separately.**

### Pattern D: Dead code from untested assumptions
16 tax_bill adapters were built before verifying the extract route handled `tax_bill` source types. **Trace the full pipeline before writing code.**

### Pattern E: Cache keys miss a dimension
Cache keyed by `sourceType` alone served wrong snapshots. **Use `this.createSnapshot()` which sets `source_adapter` automatically.**

### Pattern F: LLM prompt examples override instructions
The LLM consistently returned 1 year when the example showed 1 year, despite instructions saying 3. **Examples are stronger than instructions.**

### Pattern G: Server-side formatting prevents LLM ambiguity
`RollYear: 2025` is ambiguous. **Format dates, years, and currency server-side in `formatForExtraction()`. Never ask the LLM to do date math.**

### Pattern H: New source types need end-to-end verification
Adding `tax_bill` required extract route updates. **Check the extract handler knows about your source_type.**

### Pattern I: County zoning only covers unincorporated areas
San Benito, Monterey, Ventura — county GIS returns empty for incorporated city parcels. **Always research city-level zoning for ALL incorporated cities.** This is the #1 cause of empty zoning.

### Pattern J: APN format varies within a county
San Benito APNs: 3-segment (013-040-033) and 4-segment (013-100-015-000) both exist. Fixed-suffix approach breaks. **Use `parcelsApnPadEnd` (truncate+pad) instead of fixed suffixes. Test 3+ APNs with different segment counts.**

### Pattern K: Parcel layers lack city attribution
San Benito's parcel layer has no city field. City detection fails silently. **Check parcelsOutFields for city/jurisdiction fields. If absent, the brute-force fallback (tries each configured city's zoning at centroid) handles it.**

### Pattern L: LLM labels prior year as current
SF DataSF publishes the prior closed roll year as the most recent data. LLM calls it "current_year". **The `populateTaxFields` guard checks against the actual fiscal year. Ensure the scraper isn't the only source — ATTOM auto-fill provides the real current year.**

---

## Phase 1: Source Discovery (Research Only)

### Step 1.1: Identify All Public Data Sources

Search for these sites for the target county:
- County Assessor / Property Tax portal (assessed values)
- County Tax Collector (tax bills, payment amounts)
- County Planning / Zoning GIS (zone designation, development standards)
- ArcGIS / GIS portal (parcel geometry, zoning layers)
- City-level GIS portals for ALL incorporated cities with CRE activity

For each source: `| Source | URL | Data | API or HTML? | Auth/CAPTCHA? |`

### Step 1.2: Map ALL Incorporated Cities

Research the county's incorporated cities. For each:
1. Is there a dedicated city zoning GIS endpoint?
2. Does the county zoning layer cover this city, or return empty?
3. What is the city's population / CRE significance?

**This is the step most often skipped — it causes Pattern I failures.**

### Step 1.3: Test with 3+ Diverse APNs

Pick APNs from: (a) unincorporated area, (b) largest incorporated city, (c) secondary city if applicable.
- Hit parcel layer — verify APN lookup succeeds
- Hit county zoning at parcel centroid — does it return data or empty?
- Hit city zoning layer at same centroid — does it return the city's zone code?
- Check if parcel attributes include a city/jurisdiction field

### Step 1.4: Document APN Format

- Raw format from user input (e.g., `XXX-XXX-XX-XX`)
- GIS layer format (nodashes? padded? check digit?)
- Test 3+ APNs with different segment counts
- `normalizeApn()` logic needed
- Any `parcelsApnPadEnd`, `parcelsApnStripSegments`, `parcelsApnPrefix` config needed

### Step 1.5: Check Zone Standards

Are zone standards already seeded for this county? Check:
```bash
grep '<county-id>' docs/SCRAPER-MASTER.md
```

If not seeded, collect all zone codes from the county and city GIS layers. These will need a migration.

### Phase 1 Deliverable

Research document with all findings. Get user approval before Phase 2.

---

## Phase 2: Adapter Implementation

### Step 2.1: Create Adapter Files

One file per source: `server/src/services/scraper/adapters/<county-id>-<purpose>.js`

### Step 2.2: Adapter Code Checklist

```
[ ] Extend BaseAdapter
[ ] Call super(countyConfig) in constructor
[ ] Call waitForRateLimit(this.county.id) before EVERY external request
[ ] Use this.createSnapshot() for snapshot inserts
[ ] Use this.finalizeCapture() or this.markSnapshotFailed()
[ ] Use this.fetchArcGIS() for ArcGIS endpoints
[ ] Use this.fetchWithTimeout() for non-ArcGIS APIs
[ ] Format dates/years/currency server-side in formatForExtraction()
[ ] Return { snapshotId, html, url } from scrape()
```

### Step 2.3: ArcGIS County Config

Add to `server/src/services/scraper/data/arcgis-county-configs.js`:
```js
'<county-id>': {
  available: true,
  parcelsUrl: '...',
  parcelsApnField: 'APN',        // verify actual field name
  parcelsApnFormat: 'nodashes',   // or 'dashes', 'raw'
  parcelsApnPadEnd: 10,           // if GIS stores fixed-length APNs
  parcelsOutFields: 'APN,Juri',   // include city detection fields!
  zoningUrl: '...',
  zoningFields: ['ZONETYPE'],
  spatialRef: '4326',
},
```

### Step 2.4: City Zoning Configs

For EACH incorporated city with CRE activity, add to `server/src/services/scraper/data/arcgis-city-zoning-configs.js`:
```js
'<county-id>': {
  '<CityName>': {
    zoningUrl: '...',
    zoningFields: ['ZONE_CODE', 'ZONE_DESC'],
    spatialRef: '3857',  // the layer's native SR
  },
},
```

**If the parcel layer has NO city field:** The brute-force fallback (max 5 cities) will try each city's zoning at the centroid. No additional config needed — just add the city configs.

### Step 2.5: Register in ADAPTER_REGISTRY

In `server/src/services/scraper/adapterRegistry.js`:
1. Import the adapter class(es)
2. Add entry to `ADAPTER_REGISTRY` array
3. ArcGIS zoning auto-registers if config has `available: true`

### Step 2.6: Zone Standards Migration

If zone codes are not yet in `zone_standards`:
1. Research the municipal code for each zone's development standards
2. Create a migration: `server/db/migrations/<timestamp>_seed_<county>_zone_standards.js`
3. Include: zone_code, jurisdiction, height, FAR, density, setbacks, parking, lot_area

---

## Phase 3: Pipeline Verification

### Step 3.1: End-to-End Test (3+ APNs)

For each test APN:
```js
// Inline test script
import CONFIGS from './src/services/scraper/data/arcgis-county-configs.js';
import { getCityZoningConfig } from './src/services/scraper/data/arcgis-city-zoning-configs.js';

// 1. Parcel lookup
// 2. County zoning at centroid
// 3. City zoning at centroid (if incorporated)
// 4. Verify all return data
```

### Step 3.2: Score Against Gold+ Dimensions

Walk through all 10 dimensions from the Gold+ table above. Document pass/fail for each.

### Step 3.3: Update SCRAPER-MASTER.md

Update the county's row in the scorecard with the new grade.

---

## Phase 4: Quality Gates (ALL must pass)

### Adapter Gates
- [ ] All fields from Data Completeness Matrix accounted for
- [ ] No Playwright dependency (or documented exception)
- [ ] `source_adapter` set via `this.createSnapshot()`
- [ ] `waitForRateLimit()` called before every HTTP request
- [ ] Error handling: snapshot marked failed with error_message on every exception
- [ ] Dates/years formatted server-side

### Zoning Gates
- [ ] County zoning covers unincorporated parcels
- [ ] City configs exist for ALL incorporated cities with CRE activity
- [ ] City detection works (test with APN in each jurisdiction)
- [ ] If parcel has no city field: brute-force fallback tested

### Zone Standards Gates
- [ ] Zone codes seeded in zone_standards for county + all configured cities
- [ ] Zone standards lookup returns data for test APNs

### Integration Gates
- [ ] Adapter registered in ADAPTER_REGISTRY
- [ ] County exists in DB with correct apn_format_pattern
- [ ] Full pipeline works: create report -> scrape -> extract -> data review shows fields
- [ ] SCRAPER-MASTER.md updated with new grade

---

## Key File Paths

| File | Purpose |
|---|---|
| `server/src/services/scraper/adapters/base.js` | BaseAdapter — extend this |
| `server/src/services/scraper/adapterRegistry.js` | ADAPTER_REGISTRY — register adapters |
| `server/src/services/scraper/data/arcgis-county-configs.js` | ArcGIS county configs (parcels + zoning) |
| `server/src/services/scraper/data/arcgis-city-zoning-configs.js` | 164 city zoning configs across 34 counties |
| `server/src/services/scraper/rateLimiter.js` | `waitForRateLimit()` |
| `server/src/services/llm/index.js` | Extraction + field population |
| `server/src/services/llm/prompts/` | LLM specialist prompts |
| `docs/SCRAPER-MASTER.md` | Gold+ scorecard — update after shipping |

## BaseAdapter Helpers (call these, never reimplement)

| Helper | Purpose |
|---|---|
| `this.createSnapshot(db, { reportId, apn, sourceUrl, sourceType })` | Insert snapshot with source_adapter set |
| `this.finalizeCapture(db, snapshotId, html, finalUrl, opts)` | Validate + mark captured |
| `this.markSnapshotFailed(db, snapshotId, errorMessage)` | Mark failed in catch block |
| `this.fetchArcGIS(url, opts)` | Fetch JSON + validate ArcGIS errors |
| `this.fetchWithTimeout(url, opts)` | Fetch JSON with timeout + UA |
| `this.computeCentroid(geometry)` | Average vertex coords from polygon rings |

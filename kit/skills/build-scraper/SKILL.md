---
name: build-scraper
description: Build a county scraper adapter targeting Gold+ on the SCRAPER-MASTER.md scorecard (tax assessment, tax bill, zoning, APN format). Use when the user asks to build or add a scraper adapter for a county.
---

# Skill: Build Scraper Adapter

Build county scraper adapters targeting **Gold+** on the SCRAPER-MASTER.md scorecard. See `protocol.md` in this skill's directory for the full protocol with all failure patterns, phases, and quality gates.

## Quick Reference

### Gold+ = 10/10 Dimensions
1. Tax Assessment adapter
2. Tax Bill adapter
3. Zoning (unincorporated) via county ArcGIS
4. Zoning (incorporated) via city configs for ALL CRE cities
5. APN format verified (3+ APNs tested)
6. City detection working (parcel field / citiesUrl / brute-force)
7. Environmental (FEMA + EPA — automatic)
8. Zone standards seeded for all zone codes
9. Sales history (ATTOM — verify FIPS works)
10. End-to-end tested (1 incorporated + 1 unincorporated APN)

### BaseAdapter Helpers (call these, never reimplement)

| Helper | Purpose |
|---|---|
| `this.createSnapshot(db, { reportId, apn, sourceUrl, sourceType })` | Insert snapshot with source_adapter set |
| `this.finalizeCapture(db, snapshotId, html, finalUrl, opts)` | Validate + mark captured |
| `this.markSnapshotFailed(db, snapshotId, errorMessage)` | Mark failed in catch block |
| `this.fetchArcGIS(url, opts)` | Fetch JSON + validate ArcGIS errors |
| `this.fetchWithTimeout(url, opts)` | Fetch JSON with timeout + UA |
| `this.computeCentroid(geometry)` | Average vertex coords from polygon rings |

### Critical Patterns (most common failures)

- **Pattern I: County zoning only covers unincorporated.** ALWAYS research city-level zoning for ALL incorporated cities. This is the #1 gap.
- **Pattern J: APN format varies within a county.** Test 3+ APNs with different segment counts. Use `parcelsApnPadEnd` not fixed suffixes.
- **Pattern K: Parcel layers lack city attribution.** Brute-force fallback (max 5 cities) handles this automatically if city configs exist.
- **Pattern C: Tax amounts on different site than assessor.** Always identify assessor AND tax collector separately.

### Key Files

| File | Purpose |
|---|---|
| `docs/SCRAPER-MASTER.md` | Gold+ scorecard — check grade, update after shipping |
| `server/src/services/scraper/adapterRegistry.js` | Register adapters |
| `server/src/services/scraper/data/arcgis-county-configs.js` | County ArcGIS configs |
| `server/src/services/scraper/data/arcgis-city-zoning-configs.js` | 164 city zoning configs |
| `server/src/services/scraper/adapters/base.js` | BaseAdapter — extend this |

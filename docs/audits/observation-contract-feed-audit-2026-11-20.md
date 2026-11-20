# Observation ingestion contract v1 — fabric feed audit

Date: 2026-11-20 · Branch: `feat/observation-contract` · Author: Claude Code agent (Knock AI)

World Monitor is upstream infrastructure feeding OMEGA (CEO ruling 2026-11-15). The
canonical observation contract bridge normalizes EXISTING fabric payloads; it does not
build duplicate pipelines. This audit inventories the reusable feeds and records what the
v1 bridge covers.

## The contract (v1, observation form)

One object per geo-anchored raw observation (`derived: false` — riskIndex and
hypotheses belong to the OMEGA brain, not the ingestion layer):

```json
{
  "contractVersion": 1,
  "target": { "h3Cell": "…", "lat": …, "lng": …, "label": "…" },
  "observedAt": "ISO8601", "ingestedAt": "ISO8601", "asOf": "ISO8601",
  "availability": { "state": "AVAILABLE|STALE|MISSING|UNAVAILABLE|BLOCKED_BY_RIGHTS", "detail": "…" },
  "provenance": {
    "sourceId": "…", "sourceName": "…", "evidenceRefs": ["…"], "license": "…",
    "rightsState": "REVIEW", "authorization": { "outcome": "ALLOWED", "reason": "…" }
  },
  "classification": "SYNTHETIC|LIVE",
  "signals": [ { "id": "…", "type": "…", "value": …, "unit": "…", "derived": false, "observedAt": "…" } ],
  "gaps": ["…"]
}
```

Implementation: `scripts/_observation-contract.mjs`. Tests:
`tests/observation-contract.test.mjs` against committed fixtures in
`tests/fixtures/observation-contract/` (weather + AIS captured live from the production
fabric on the OMEGA box 2026-11-20; outages built from the seeder's exact record
construction because the prod key had expired at capture time).

### H3 resolution choices

| Feed | Resolution | Rationale |
|---|---|---|
| Weather alerts | res 7 (~1.2 km edge) | Alert polygons are tens of km; centroid anchor carries no more precision. |
| Maritime AIS | res 9 (~174 m edge) | Vessel position reports are metre-grade GPS fixes. |
| Infrastructure outages | res 7 | Radar annotations are country-centroid scoped — finer cells imply precision the upstream lacks. |

### Normalizer behavior (all three)

- Takes the existing fabric payload shape (seed-envelope aware via
  `unwrapEnvelope`; `asOf` prefers `_seed.fetchedAt`, else the relay snapshot
  timestamp, else ingestion time).
- Emits `rightsState: 'REVIEW'` on every observation; `authorization.outcome:
  'ALLOWED'` records the internal-use basis (CEO production GO 2026-11-15) only.
  Nothing is integrated into commercial scoring.
- `classification: 'LIVE'` by default; `'SYNTHETIC'` only in fixtures/tests.
- Fail-closed: unknown payload shape → `availability.state: 'UNAVAILABLE'` with
  detail, zero observations. Records that cannot be geo-anchored or attributed are
  reported in `skipped`, never fabricated.
- AIS not-available sentinels (SOG 102.3 kn, COG 360°, heading 511°) become gap
  notes, not measurements.

## Feed inventory

Rights default REVIEW for every feed; CLEAR requires a source-card decision
(none exists for these feeds). License strings come from
`shared/source-attribution-manifest.json` plus the licensing rulings in project
memory.

| Feed | Source(s) | Rights | Data shape (fabric payload) | Refresh path | Current consumers |
|---|---|---|---|---|---|
| Weather alerts | NWS `api.weather.gov/alerts/active` + ECCC `api.weather.gc.ca` + WMO SWIC `severeweather.wmo.int` | REVIEW | Redis `weather:alerts:v1` → `{ _seed, data: { alerts: [{ id, event, severity, headline, description, areaDesc, onset, expires, coordinates, centroid [lon,lat], countryCode, source: nws\|eccc\|swic, vtec?, urgency?, certainty?, geometryPrecision? }] } }` | Relay live writer (TTL 5400s) + `scripts/seed-weather-alerts.mjs` (cron, TTL 900s); merge/selection in `scripts/_weather-alert-select.mjs` | omega-web `/api/signals/weather`; World Monitor weather layer; `weather_alert` notification events |
| Maritime AIS (vessels/tankers) | AISStream.io WebSocket | REVIEW | Relay HTTP `GET /ais/snapshot` → `{ sequence, timestamp, status { connected, currentPositionReady, vessels, … }, disruptions, density, candidateReports [ { mmsi, name, lat, lon, shipType, heading, speed, course, timestamp } ], tankerReports [ … ] }` | Relay `scripts/ais-relay.cjs` (in-memory maps, 2s snapshot cadence, pre-gzipped); derived Redis seeds `supply_chain:chokepoint_transits:v1` (10 min) | omega-web `/api/signals/vessels`; maritime/tanker globe layers; chokepoint transit counts |
| Internet outages (infrastructure) | Cloudflare Radar outage annotations | REVIEW (CC BY-NC 4.0; CEO precedent ruling 2026-11-15, exception path radar@cloudflare.com) | Redis `infra:outages:v1` → `{ outages: [{ id: 'cf-…', title, link, description, detectedAt (ms), country, region, location { latitude, longitude }, severity, categories, cause, outageType, endedAt (ms) }] }` | `scripts/seed-internet-outages.mjs` (30-min cron intent, TTL 3h; also writes `cf:radar:ddos:v1`, `cf:radar:traffic-anomalies:v1`) | omega-web `/api/signals/outages` + `radar-extras`; World Monitor outages layer |
| Freight / port activity | IMF PortWatch | REVIEW | `supply_chain:portwatch:v1`, `portwatch:disruptions:active:v1`, `portwatch:chokepoints:ref:v1`, `supply_chain:portwatch-ports:v1:_countries` | Seed scripts (cron): `scripts/seed-portwatch*.mjs` | omega-web `/api/signals/supply-chain`; supply-chain panel |
| Maritime fleet (USNI) | USNI News fleet tracker | REVIEW | `military:usni-fleet:v1` → vessels with `regionLat/regionLon`, strike groups, regions | Relay boot seed | omega-web `/api/signals/fleet`; fleet globe layer |
| Theater posture | adsb.lol + relay vessel counts | REVIEW | `theater-posture:sebuf:v1` → theaters + static geo boxes | Relay auto-seed | omega-web `/api/signals/theater`; posture boxes |
| Satellite-observation | CelesTrak TLEs; OpenSky flights | REVIEW | `intelligence:satellites:tle:v1` (TLEs); relay `/opensky` (states) | Relay boot/auto-seed; OpenSky creds-gated (prod 503 as of 2026-11-17) | omega-web `/api/signals/satellites`, `/api/signals/flights` |
| GPS jamming (infrastructure) | gpsjam.org | REVIEW | `intelligence:gpsjam:v1/v2` (per-H3-cell aircraft GPS availability) | `scripts/fetch-gpsjam.mjs` | World Monitor internet layer |
| Seismology | USGS 4.5_week GeoJSON + NRCan ATOM | REVIEW | `seismology:earthquakes:v1` | `scripts/seed-earthquakes.mjs` (1h cron, TTL 6h) | seismology panel; brain asks (41 quakes M2.5+ canary) |
| Markets / economic | Yahoo Finance, FRED, etc. | REVIEW | `market:*`, `economic:*` keys | Relay auto-seeds | omega-web `/api/signals/markets`, `/api/signals/economic` |
| News / research / climate | RSS proxies, USNI, research feeds | REVIEW | per-domain `intelligence:*` keys | Relay pollers | `/api/intel`, BriefFeed, omega-web signals board |
| Conflicts (UCDP/ACLED) | UCDP API, ACLED | REVIEW (creds-gated, currently 401) | `conflict:ucdp-events:v1` | Relay seed (v24.1+ release tracking) | conflict panel |
| GEV public cameras | TfL JamCams, Fintraffic weather cams | REVIEW (counsel question open) | `webcam:gev:cameras` (50 cams), `webcam:gev:rights` registry | Manual seed on fabric box | omega-web `/api/signals/cameras` + frame proxy |

### Reusable feed families (the five the bridge targets)

- **maritime** — AIS vessels/tankers, chokepoint transits, USNI fleet, theater posture.
- **freight** — PortWatch ports, disruptions, chokepoint reference.
- **weather** — NWS/ECCC/SWIC merged alerts (one pipeline, three sources).
- **infrastructure** — Cloudflare Radar outages/DDoS/anomalies + GPSJam.
- **satellite-observation** — CelesTrak TLEs + OpenSky flights.

### Feeds deliberately left out of v1

| Feed | Reason |
|---|---|
| Seismology (quakes) | Clean shape and the natural fourth normalizer; left out to keep this PR scoped to the three named feeds. |
| Freight / PortWatch | Records are per-port aggregates, not single-target observations — needs a target-anchoring decision (port vs country) before mapping. |
| Satellite-observation (TLEs) | TLEs are orbital elements; positions derived from them are `derived: true` (brain territory), so the target model (satellite id vs H3 cell) must be settled first. |
| Aviation (OpenSky/adsb.lol) | OpenSky credentials absent on the prod relay (`/opensky` 503) — no cleanly capturable payload today. |
| GPSJam | Already H3-keyed aggregate grids; ingestion is a res-remap, deferred until the brain's cell-resolution expectations are fixed. |
| Markets, news, conflicts, cameras | Not geo-instant observations (markets) or already covered by dedicated rights-gated paths (cameras) or creds-gated (UCDP/ACLED). |

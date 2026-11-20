# Observation ingestion contract v1 — fabric feed audit

Date: 2026-11-20 · Branch: `feat/observation-contract` · Author: Claude Code agent (Knock AI)

World Monitor is upstream infrastructure feeding OMEGA (CEO ruling 2026-11-15). The
canonical observation contract bridge normalizes EXISTING fabric payloads; it does not
build duplicate pipelines. This audit inventories the reusable feeds and records what the
v1 bridge covers.

## The contract (v1, observation form)

One object per geo-anchored observation, aligned with the canonical JSON Schema
committed at `schemas/intelligence_contract_v1.json` (byte-identical copy of
KnockAI/Omega PR #7's `schemas/intelligence_contract_v1.json`; provenance and
sha256 asserted in `tests/observation-contract-schema.test.mjs`):

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
  "riskIndex": { "value": null, "calibrationState": "UNCALIBRATED", "confidence": 0, "semantics": "heuristic" },
  "hypotheses": [],
  "gaps": ["…"]
}
```

### Raw vs derived signals (the split)

The canonical schema requires every `signals[].value` to be a finite number
and carries an explicit `derived` flag per signal:

- **RAW (`derived: false`)** — direct feed-measured facts, forwarded verbatim:
  a presence signal (value 1 — the feed carries exactly one such record for
  this target after dedup; a missing record is the absence of the
  observation, never a zero-valued signal) and the verbatim AIS numbers
  (SOG/COG/true heading/AIS ship-type code) with ITU-R M.1371
  not-available sentinels filtered into gaps.
- **DERIVED (`derived: true`)** — numeric intelligence normalized beyond a
  direct measurement, with the ladder pinned in the module: CAP severity
  `{Unknown:0, Minor:1, Moderate:2, Severe:3, Extreme:4}`, CAP urgency
  `{Past/Unknown:0, Future:1, Expected:2, Immediate:3}`, CAP certainty
  `{Unknown/Unlikely:0, Possible:1, Likely:2, Observed:3}`, and the Radar
  outage scope ladder `{PARTIAL:1, MAJOR:2, TOTAL:3}`. A category outside
  the ladder emits no rank signal (fail-closed gap note) — never a
  fabricated rank.
- **Categorical identity** (event names, VTEC codes, outage type/cause,
  country) is text, not a number: it rides `target.label` and
  `provenance.evidenceRefs`, never a string-valued signal.

### Point-in-time ordering (fail-closed)

`observedAt <= ingestedAt <= asOf` on every emitted observation:

- `asOf` defaults to `ingestedAt` (the observation set is valid as of
  ingestion); an explicit `asOf` before `ingestedAt` fails the whole feed
  closed to `UNAVAILABLE`.
- Records whose own measurement timestamp postdates ingestion (AIS position
  report timestamp, outage `detectedAt`) are dropped into `skipped` with the
  violation as the reason.
- Weather alert `onset`/`expires` are event timing, not observation timing: a
  warning issued now for a storm starting tomorrow is observed now. The
  observedAt anchor chain is onset (when already past) → seed `fetchedAt`
  (when the fabric observed the alert) → `ingestedAt`, each fallback recorded
  as a gap. A future onset therefore never manufactures an ordering violation.

### Risk index and hypotheses (brain-side, schema-required)

The canonical schema requires `riskIndex` and `hypotheses` on every payload,
so observations carry the brain-neutral form — `riskIndex { value: null,
calibrationState: "UNCALIBRATED", confidence: 0, semantics: "heuristic" }`
(exactly the canonical Python consumer's default factory) and `hypotheses: []`
— plus a gap documenting the deferral. The OMEGA brain replaces both when it
composes an intelligence response; the ingestion layer never invents a risk
value. This is the documented observation-form subset: everything else
validates against the full canonical schema
(`tests/observation-contract-schema.test.mjs`).

Implementation: `scripts/_observation-contract.mjs`. Tests:
`tests/observation-contract.test.mjs` (behavioral: raw/derived split,
ordering boundaries, fail-closed skips) and
`tests/observation-contract-schema.test.mjs` (canonical-schema compatibility)
against committed fixtures in `tests/fixtures/observation-contract/` (weather
and AIS captured live from the production fabric on the OMEGA box 2026-11-20;
outages built from the seeder's exact record construction because the prod key
had expired at capture time).

### H3 resolution choices

| Feed | Resolution | Rationale |
|---|---|---|
| Weather alerts | res 7 (~1.2 km edge) | Alert polygons are tens of km; centroid anchor carries no more precision. |
| Maritime AIS | res 9 (~174 m edge) | Vessel position reports are metre-grade GPS fixes. |
| Infrastructure outages | res 7 | Radar annotations are country-centroid scoped — finer cells imply precision the upstream lacks. |

### Normalizer behavior (all three)

- Takes the existing fabric payload shape (seed-envelope aware via
  `unwrapEnvelope`; `asOf` defaults to ingestion time — the seed
  `fetchedAt` and the relay snapshot build time are preserved as
  evidenceRefs, not claimed as the answer's point-in-time).
- Emits `rightsState: 'REVIEW'` on every observation; `authorization.outcome:
  'ALLOWED'` records the internal-use basis (CEO production GO 2026-11-15) only.
  Nothing is integrated into commercial scoring.
- `classification: 'LIVE'` by default; `'SYNTHETIC'` only in fixtures/tests.
- Fail-closed: unknown payload shape → `availability.state: 'UNAVAILABLE'` with
  detail, zero observations. Records that cannot be geo-anchored, attributed,
  or point-in-time ordered are reported in `skipped`, never fabricated.
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

## Review corrections (2026-11-20, REDTEAM follow-up)

Four corrections landed on the same branch after the REDTEAM review:

1. **Raw vs derived split.** `signals[].derived` is now caller-owned and
   honest: presence + verbatim AIS measurements are `derived: false`; severity/
   urgency/certainty/outage-scope ordinal ranks are `derived: true` with the
   ladders pinned in the module header and this audit. Categorical identity
   (event, VTEC, outage type/cause) rides `target.label` +
   `evidenceRefs — the canonical schema only allows numeric signal values.
2. **Point-in-time ordering.** `observedAt <= ingestedAt <= asOf` enforced on
   every emitted observation, fail-closed (see above). Boundary tests included
   (equality allowed; one millisecond over drops the record or the feed).
3. **OMEGA consumer compatibility.** `schemas/intelligence_contract_v1.json`
   is a committed byte-identical copy of the canonical schema from
   KnockAI/Omega PR #7 (head `6c7e906a`, blob `e7696a45`, sha256 asserted in
   test). `tests/observation-contract-schema.test.mjs` validates every
   normalizer output for every fixture against it via ajv (already a pinned
   devDependency) with negative controls proving the validator bites, plus the
   documented observation-form subset for the brain-side `riskIndex`/
   `hypotheses` fields. No duplicate pipelines, no rights changes.
4. **CI runner.** The two red checks (`changes`, `typecheck-changes`) failed
   only because the fork's `knock/main` pinned these workflows to the
   self-hosted `omega-vps-runner`, which lacks the `gh` CLI (exit 127). The
   PR moves the Test/Typecheck/Lint Code workflow jobs back to GitHub-hosted
   `ubuntu-latest` runners — the repo is public (free minutes) and no
   production infrastructure is touched.

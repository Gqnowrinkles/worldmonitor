// Canonical observation ingestion contract (v1) — normalizers that map EXISTING
// world-monitor fabric payloads onto the OMEGA intelligence observation shape.
//
// This module does NOT fetch anything and does NOT build duplicate pipelines.
// It normalizes payloads already produced by the fabric:
//   - weather:  the `weather:alerts:v1` canonical Redis payload (NWS + ECCC +
//     WMO SWIC alerts merged by scripts/_weather-alert-select.mjs, written by
//     scripts/seed-weather-alerts.mjs and the live ais-relay weather writer),
//     optionally wrapped in the { _seed, data } seed envelope.
//   - maritime: the ais-relay `/ais/snapshot` HTTP payload
//     (scripts/ais-relay.cjs buildSnapshot + getTankerReportsSnapshot +
//     getCandidateReportsSnapshot), whose vessel records follow the
//     { mmsi, name, lat, lon, shipType, heading, speed, course, timestamp }
//     shape built in processPositionReportForSnapshot.
//   - infrastructure: the `infra:outages:v1` canonical Redis payload
//     (Cloudflare Radar outage annotations, written by
//     scripts/seed-internet-outages.mjs), optionally seed-envelope wrapped.
//
// Contract shape (one object per geo-anchored raw observation; derived:false —
// riskIndex/hypotheses belong to the OMEGA brain, not here):
//   {
//     contractVersion: 1,
//     target: { h3Cell, lat, lng, label },
//     observedAt, ingestedAt, asOf,            // ISO8601
//     availability: { state, detail },         // AVAILABLE|STALE|MISSING|UNAVAILABLE|BLOCKED_BY_RIGHTS
//     provenance: { sourceId, sourceName, evidenceRefs, license, rightsState, authorization },
//     classification: 'LIVE' | 'SYNTHETIC',
//     signals: [ { id, type, value, unit, derived: false, observedAt } ],
//     gaps: [ '...' ]
//   }
//
// H3 resolution choices (documented per task requirement):
//   - weather alerts: res 7 (~1.2 km edge) — alert polygons are tens of km
//     wide; the centroid anchor carries no more precision than that, and res 7
//     keeps alert neighborhoods comparable across the merged NWS/ECCC/SWIC set.
//   - maritime AIS: res 9 (~174 m edge) — vessel position reports are metre-grade
//     GPS fixes; res 9 preserves neighborhood fidelity for traffic analysis.
//   - infrastructure outages: res 7 — Cloudflare Radar outage annotations are
//     country-centroid scoped (scripts/seed-internet-outages.mjs maps every
//     outage onto its country centroid), so finer cells would imply precision
//     the upstream does not carry.
//
// Rights posture: every observation is emitted with rightsState 'REVIEW'.
// Nothing here integrates a dataset into commercial scoring; the authorization
// block records the internal-use basis only. A source is only marked CLEAR by
// an explicit source-card decision elsewhere (none exist for these feeds yet).
//
// Fail-closed: an unrecognized payload shape yields availability.state
// 'UNAVAILABLE' with a detail string and NO observations — observations are
// never fabricated. Individual records that cannot be geo-anchored or whose
// provenance is unresolvable are skipped and reported in `skipped`, not
// invented.

import { latLngToCell } from 'h3-js';

import { unwrapEnvelope } from './_seed-envelope-source.mjs';

export const CONTRACT_VERSION = 1;

export const H3_RESOLUTIONS = Object.freeze({
  weatherAlerts: 7,
  maritimeVessel: 9,
  infrastructureOutage: 7,
});

export const AVAILABILITY_STATES = Object.freeze([
  'AVAILABLE',
  'STALE',
  'MISSING',
  'UNAVAILABLE',
  'BLOCKED_BY_RIGHTS',
]);

const RIGHTS_STATE_REVIEW = 'REVIEW';

// Internal-use authorization carried on every observation. Rights themselves
// stay REVIEW; the CEO production GO (2026-11-15) covers internal ingestion
// and serving of the fabric, not a commercial-rights grant.
const AUTHORIZATION_INTERNAL_USE = Object.freeze({
  outcome: 'ALLOWED',
  reason:
    'Internal ingestion + session-gated serving under CEO production GO 2026-11-15; commercial use pending rights review (counsel + CEO).',
});

const MAX_LABEL_LENGTH = 160;

function truncateLabel(text, max = MAX_LABEL_LENGTH) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function describeShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') {
    return `object with keys [${Object.keys(value)
      .slice(0, 8)
      .join(', ')}]`;
  }
  return typeof value;
}

/**
 * Convert an epoch-ms number or an ISO-ish string to a strict ISO8601 UTC
 * timestamp. Returns null for anything unparsable — callers decide the
 * fallback (usually ingestedAt + a gap note), so a bad upstream timestamp can
 * never silently become epoch 0.
 */
function toIsoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

function isFiniteLatitude(lat) {
  return typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

function isFiniteLongitude(lng) {
  return typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

function h3CellFor(lat, lng, resolution) {
  try {
    const cell = latLngToCell(lat, lng, resolution);
    return typeof cell === 'string' && cell.length > 0 ? cell : null;
  } catch {
    return null;
  }
}

function resolveClassification(candidate) {
  return candidate === 'SYNTHETIC' ? 'SYNTHETIC' : 'LIVE';
}

function resolveTimestamps({ opts, seed, fallbackAsOf }) {
  const ingestedAt = toIsoTimestamp(opts.ingestedAt) ?? new Date().toISOString();
  const asOf = toIsoTimestamp(opts.asOf ?? seed?.fetchedAt) ?? toIsoTimestamp(fallbackAsOf) ?? ingestedAt;
  return { ingestedAt, asOf };
}

function buildProvenance({ sourceId, sourceName, evidenceRefs, license, authorization = AUTHORIZATION_INTERNAL_USE }) {
  return {
    sourceId,
    sourceName,
    evidenceRefs: evidenceRefs.filter((ref) => typeof ref === 'string' && ref.length > 0),
    license,
    rightsState: RIGHTS_STATE_REVIEW,
    authorization,
  };
}

function buildObservation({
  h3Cell,
  lat,
  lng,
  label,
  observedAt,
  ingestedAt,
  asOf,
  provenance,
  availability = { state: 'AVAILABLE', detail: '' },
  classification = 'LIVE',
  signals = [],
  gaps = [],
}) {
  return {
    contractVersion: CONTRACT_VERSION,
    target: { h3Cell, lat, lng, label },
    observedAt,
    ingestedAt,
    asOf,
    availability,
    provenance,
    classification,
    signals,
    gaps,
  };
}

function failClosedResult(detail) {
  return {
    availability: { state: 'UNAVAILABLE', detail },
    observations: [],
    skipped: [],
  };
}

function buildSignal({ id, type, value, unit, observedAt }) {
  return { id, type, value, unit, derived: false, observedAt };
}

// ---------------------------------------------------------------------------
// Weather alerts — `weather:alerts:v1`
// ---------------------------------------------------------------------------

const WEATHER_REDIS_KEY_REF = 'redis:weather:alerts:v1';

const WEATHER_ALERT_SOURCES = Object.freeze({
  nws: Object.freeze({
    sourceId: 'nws-alerts',
    sourceName: 'U.S. National Weather Service (api.weather.gov)',
    license: 'api.weather.gov API terms; U.S. government work (verify before redistribution)',
    recordRef: (id) =>
      /^https?:\/\//.test(id) ? id : `https://api.weather.gov/alerts/${encodeURIComponent(id)}`,
  }),
  eccc: Object.freeze({
    sourceId: 'eccc-alerts',
    sourceName: 'Environment and Climate Change Canada (api.weather.gc.ca)',
    license: 'ECCC Data Server End-use Licence (Government of Canada open data)',
    recordRef: (id) => `https://api.weather.gc.ca/collections/weather-alerts/items/${encodeURIComponent(id)}`,
  }),
  swic: Object.freeze({
    sourceId: 'swic-alerts',
    sourceName: 'WMO Severe Weather Information Centre (severeweather.wmo.int)',
    license: 'WMO SWIC terms of service (verify before redistribution)',
    recordRef: (id) => `swic:alert:${id}`,
  }),
});

/**
 * Normalize the `weather:alerts:v1` canonical payload into contract
 * observations. Accepts the bare payload or the { _seed, data } seed
 * envelope (the envelope's `fetchedAt` becomes `asOf` when present).
 *
 * Each alert becomes one observation anchored at its GeoJSON-order centroid
 * [lon, lat] (calculateCentroid in scripts/_weather-alert-select.mjs), H3
 * res 7. Alerts without a usable centroid or with an unknown `source` are
 * skipped — never fabricated.
 *
 * @returns {{ availability: { state: string, detail: string }, observations: object[], skipped: Array<{ id: string, reason: string }> }}
 */
export function normalizeWeatherAlerts(rawPayload, opts = {}) {
  const { _seed, data } = unwrapEnvelope(rawPayload);
  if (data === null || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.alerts)) {
    return failClosedResult(
      `weather:alerts:v1 payload shape not recognized — expected object with an alerts array, got ${describeShape(data)}`,
    );
  }

  const { ingestedAt, asOf } = resolveTimestamps({ opts, seed: _seed });
  const classification = resolveClassification(opts.classification);

  let availability;
  if (data.sourceState === 'degraded') {
    const failed = Array.isArray(data.failedSources) ? data.failedSources.join(', ') : 'unknown';
    availability = {
      state: 'STALE',
      detail: `weather alert source degraded (failed: ${failed}${data.skipReason ? `; ${data.skipReason}` : ''})`,
    };
  } else {
    availability = {
      state: 'AVAILABLE',
      detail: data.alerts.length === 0 ? 'zero active alerts (valid quiet state)' : '',
    };
  }

  const observations = [];
  const skipped = [];

  for (const alert of data.alerts) {
    if (alert === null || typeof alert !== 'object') {
      skipped.push({ id: '', reason: 'alert record is not an object' });
      continue;
    }

    const source = WEATHER_ALERT_SOURCES[alert.source];
    if (!source) {
      skipped.push({
        id: String(alert.id ?? ''),
        reason: `unknown alert source '${alert.source}' — provenance not resolvable, fail-closed`,
      });
      continue;
    }

    const centroid = Array.isArray(alert.centroid) ? alert.centroid : null;
    const lng = centroid ? centroid[0] : undefined;
    const lat = centroid ? centroid[1] : undefined;
    if (!isFiniteLatitude(lat) || !isFiniteLongitude(lng)) {
      skipped.push({
        id: String(alert.id ?? ''),
        reason: 'missing or non-finite centroid — cannot geo-anchor',
      });
      continue;
    }

    const gaps = [];
    let observedAt = toIsoTimestamp(alert.onset);
    if (!observedAt) {
      observedAt = toIsoTimestamp(alert.expires);
    }
    if (!observedAt) {
      observedAt = ingestedAt;
      gaps.push('onset and expires unparsable — observedAt fell back to ingestion time');
    }
    if (alert.geometryPrecision === 'country') {
      gaps.push('centroid at country precision (geometryPrecision=country) — coarse geo anchor');
    } else if (alert.geometryPrecision === 'point') {
      gaps.push('centroid at point precision (geometryPrecision=point)');
    }

    const signals = [
      buildSignal({ id: 'severity', type: 'weather.alert.severity', value: alert.severity ?? null, unit: 'category', observedAt }),
      buildSignal({ id: 'event', type: 'weather.alert.event', value: alert.event ?? '', unit: 'text', observedAt }),
    ];
    if (typeof alert.urgency === 'string' && alert.urgency) {
      signals.push(buildSignal({ id: 'urgency', type: 'weather.alert.urgency', value: alert.urgency, unit: 'category', observedAt }));
    }
    if (typeof alert.certainty === 'string' && alert.certainty) {
      signals.push(buildSignal({ id: 'certainty', type: 'weather.alert.certainty', value: alert.certainty, unit: 'category', observedAt }));
    }
    if (typeof alert.vtec === 'string' && alert.vtec) {
      signals.push(buildSignal({ id: 'vtec', type: 'weather.alert.vtec', value: alert.vtec, unit: 'nws-vtec', observedAt }));
    }

    const id = String(alert.id ?? '');
    observations.push(
      buildObservation({
        h3Cell: h3CellFor(lat, lng, H3_RESOLUTIONS.weatherAlerts),
        lat,
        lng,
        label: truncateLabel(`${alert.event || 'weather alert'} — ${alert.areaDesc || alert.countryCode || id}`),
        observedAt,
        ingestedAt,
        asOf,
        provenance: buildProvenance({
          sourceId: source.sourceId,
          sourceName: source.sourceName,
          evidenceRefs: [id ? source.recordRef(id) : '', WEATHER_REDIS_KEY_REF],
          license: source.license,
        }),
        availability,
        classification,
        signals,
        gaps,
      }),
    );
  }

  return { availability, observations, skipped };
}

// ---------------------------------------------------------------------------
// Maritime AIS vessel reports — relay `/ais/snapshot`
// ---------------------------------------------------------------------------

const AIS_SNAPSHOT_REF = 'relay:/ais/snapshot';

const AIS_PROVENANCE_BASE = Object.freeze({
  sourceId: 'aisstream',
  sourceName: 'AISStream.io (world-monitor AIS relay)',
  license: 'AISStream.io terms of service (commercial terms under review)',
});

// AIS "not available" sentinels (ITU-R M.1371): SOG 102.3 kn, COG 360°,
// true heading 511°. The relay forwards them verbatim, so the normalizer
// filters them instead of emitting a 511° heading as a measurement.
const AIS_SOG_UNAVAILABLE = 102.3;
const AIS_COG_UNAVAILABLE = 360;
const AIS_HEADING_UNAVAILABLE = 511;

function isValidVesselReport(report) {
  return (
    report !== null &&
    typeof report === 'object' &&
    String(report.mmsi ?? '') !== '' &&
    isFiniteLatitude(report.lat) &&
    isFiniteLongitude(report.lon)
  );
}

/**
 * Normalize the ais-relay `/ais/snapshot` payload into contract observations —
 * one per vessel position report. The relay snapshot exposes vessel-shaped
 * arrays in `tankerReports` (AIS ship types 80–89) and `candidateReports`
 * (military candidates); the general `vessels` map is summarized as a count
 * in `status.vessels` and is not serialized, so this normalizer consumes the
 * two report arrays. Records are deduplicated by MMSI with tankerReports
 * taking precedence. Vessel records follow the shape built in
 * processPositionReportForSnapshot: { mmsi, name, lat, lon, shipType,
 * heading, speed, course, timestamp } (timestamp epoch ms).
 *
 * @returns {{ availability: { state: string, detail: string }, observations: object[], skipped: Array<{ id: string, reason: string }> }}
 */
export function normalizeAisVesselReports(rawSnapshot, opts = {}) {
  const snapshot = rawSnapshot;
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    snapshot === null ||
    typeof snapshot.status !== 'object' ||
    !Number.isFinite(Number(snapshot.status?.vessels))
  ) {
    return failClosedResult(
      `ais-relay snapshot shape not recognized — expected object with a numeric status.vessels, got ${describeShape(snapshot)}`,
    );
  }

  const vesselCount = Number(snapshot.status.vessels);
  const connected = snapshot.status.connected === true;
  let availability;
  if (vesselCount > 0) {
    availability = connected
      ? { state: 'AVAILABLE', detail: '' }
      : { state: 'STALE', detail: 'AIS upstream disconnected — serving retained vessel positions' };
  } else {
    availability = { state: 'MISSING', detail: 'relay snapshot reports zero tracked vessels' };
  }

  const { ingestedAt, asOf } = resolveTimestamps({ opts, seed: null, fallbackAsOf: snapshot.timestamp });
  const classification = resolveClassification(opts.classification);

  const observations = [];
  const skipped = [];
  const seenMmsi = new Set();
  const tankerReports = Array.isArray(snapshot.tankerReports) ? snapshot.tankerReports : [];
  const candidateReports = Array.isArray(snapshot.candidateReports) ? snapshot.candidateReports : [];

  for (const report of [...tankerReports, ...candidateReports]) {
    const mmsi = String(report?.mmsi ?? '');
    if (mmsi !== '' && seenMmsi.has(mmsi)) {
      continue;
    }
    if (!isValidVesselReport(report)) {
      skipped.push({
        id: String(report?.mmsi ?? ''),
        reason: 'missing mmsi or non-finite lat/lon — cannot geo-anchor',
      });
      continue;
    }
    seenMmsi.add(mmsi);

    const gaps = [];
    let observedAt = toIsoTimestamp(report.timestamp);
    if (!observedAt) {
      observedAt = ingestedAt;
      gaps.push('position report timestamp missing — observedAt fell back to ingestion time');
    }

    const signals = [];
    if (typeof report.speed === 'number' && Number.isFinite(report.speed) && report.speed < AIS_SOG_UNAVAILABLE) {
      signals.push(buildSignal({ id: 'speed', type: 'vessel.speed_sog', value: report.speed, unit: 'kn', observedAt }));
    } else if (report.speed === AIS_SOG_UNAVAILABLE) {
      gaps.push('SOG 102.3 kn — AIS not-available sentinel, no speed signal emitted');
    }
    if (typeof report.course === 'number' && Number.isFinite(report.course) && report.course < AIS_COG_UNAVAILABLE) {
      signals.push(buildSignal({ id: 'course', type: 'vessel.course_cog', value: report.course, unit: 'deg', observedAt }));
    } else if (report.course === AIS_COG_UNAVAILABLE) {
      gaps.push('COG 360° — AIS not-available sentinel, no course signal emitted');
    }
    if (
      typeof report.heading === 'number' &&
      Number.isFinite(report.heading) &&
      report.heading !== AIS_HEADING_UNAVAILABLE
    ) {
      signals.push(buildSignal({ id: 'heading', type: 'vessel.heading_true', value: report.heading, unit: 'deg', observedAt }));
    } else if (report.heading === AIS_HEADING_UNAVAILABLE) {
      gaps.push('true heading 511° — AIS not-available sentinel, no heading signal emitted');
    }
    if (typeof report.shipType === 'number' && Number.isFinite(report.shipType) && report.shipType > 0) {
      signals.push(
        buildSignal({ id: 'aisShipType', type: 'vessel.ais_ship_type', value: report.shipType, unit: 'ais-type-code', observedAt }),
      );
    } else {
      gaps.push('AIS ship type unknown (no ShipStaticData frame cached for this MMSI)');
    }

    observations.push(
      buildObservation({
        h3Cell: h3CellFor(report.lat, report.lon, H3_RESOLUTIONS.maritimeVessel),
        lat: report.lat,
        lng: report.lon,
        label: truncateLabel(String(report.name ?? '').trim() || `AIS MMSI ${mmsi}`),
        observedAt,
        ingestedAt,
        asOf,
        provenance: buildProvenance({
          sourceId: AIS_PROVENANCE_BASE.sourceId,
          sourceName: AIS_PROVENANCE_BASE.sourceName,
          evidenceRefs: [AIS_SNAPSHOT_REF, `aisstream:mmsi:${mmsi}`],
          license: AIS_PROVENANCE_BASE.license,
        }),
        availability,
        classification,
        signals,
        gaps,
      }),
    );
  }

  return { availability, observations, skipped };
}

// ---------------------------------------------------------------------------
// Internet outages — `infra:outages:v1` (Cloudflare Radar annotations)
// ---------------------------------------------------------------------------

const OUTAGES_REDIS_KEY_REF = 'redis:infra:outages:v1';

const OUTAGE_PROVENANCE_BASE = Object.freeze({
  sourceId: 'cloudflare-radar',
  sourceName: 'Cloudflare Radar outage annotations',
  license: 'Cloudflare Radar API data — CC BY-NC 4.0 (commercial exception path: radar@cloudflare.com)',
});

/**
 * Normalize the `infra:outages:v1` canonical payload into contract
 * observations. Records follow scripts/seed-internet-outages.mjs
 * construction: { id, title, link, description, detectedAt (epoch ms),
 * country, region, location: { latitude, longitude }, severity, categories,
 * cause, outageType, endedAt (epoch ms) }. Every record is country-centroid
 * scoped, so the H3 resolution is 7.
 *
 * @returns {{ availability: { state: string, detail: string }, observations: object[], skipped: Array<{ id: string, reason: string }> }}
 */
export function normalizeInternetOutages(rawPayload, opts = {}) {
  const { _seed, data } = unwrapEnvelope(rawPayload);
  if (data === null || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.outages)) {
    return failClosedResult(
      `infra:outages:v1 payload shape not recognized — expected object with an outages array, got ${describeShape(data)}`,
    );
  }

  const { ingestedAt, asOf } = resolveTimestamps({ opts, seed: _seed });
  const classification = resolveClassification(opts.classification);

  const availability = {
    state: 'AVAILABLE',
    detail: data.outages.length === 0 ? 'zero curated Radar outages in 28d window (normal sparse state)' : '',
  };

  const observations = [];
  const skipped = [];

  for (const outage of data.outages) {
    if (outage === null || typeof outage !== 'object') {
      skipped.push({ id: '', reason: 'outage record is not an object' });
      continue;
    }

    const lat = outage.location?.latitude;
    const lng = outage.location?.longitude;
    if (!isFiniteLatitude(lat) || !isFiniteLongitude(lng)) {
      skipped.push({
        id: String(outage.id ?? ''),
        reason: 'missing or non-finite location — cannot geo-anchor',
      });
      continue;
    }

    const gaps = [];
    let observedAt = toIsoTimestamp(outage.detectedAt);
    if (!observedAt) {
      observedAt = ingestedAt;
      gaps.push('detectedAt missing or unparsable — observedAt fell back to ingestion time');
    }
    const endedAt = toIsoTimestamp(outage.endedAt);
    if (endedAt) {
      gaps.push(`outage reported ended at ${endedAt} — retained within the Radar 28d annotation window`);
    }

    const signals = [
      buildSignal({ id: 'outageSeverity', type: 'infra.outage.severity', value: outage.severity ?? null, unit: 'category', observedAt }),
      buildSignal({ id: 'outageType', type: 'infra.outage.type', value: outage.outageType ?? '', unit: 'category', observedAt }),
    ];
    if (typeof outage.cause === 'string' && outage.cause) {
      signals.push(buildSignal({ id: 'outageCause', type: 'infra.outage.cause', value: outage.cause, unit: 'text', observedAt }));
    }

    const id = String(outage.id ?? '');
    const link = typeof outage.link === 'string' && /^https?:\/\//.test(outage.link) ? outage.link : '';
    observations.push(
      buildObservation({
        h3Cell: h3CellFor(lat, lng, H3_RESOLUTIONS.infrastructureOutage),
        lat,
        lng,
        label: truncateLabel(outage.title || `Internet disruption in ${outage.country ?? 'unknown country'}`),
        observedAt,
        ingestedAt,
        asOf,
        provenance: buildProvenance({
          sourceId: OUTAGE_PROVENANCE_BASE.sourceId,
          sourceName: OUTAGE_PROVENANCE_BASE.sourceName,
          evidenceRefs: [id ? `cloudflare-radar:annotation:${id}` : '', link, OUTAGES_REDIS_KEY_REF],
          license: OUTAGE_PROVENANCE_BASE.license,
        }),
        availability,
        classification,
        signals,
        gaps,
      }),
    );
  }

  return { availability, observations, skipped };
}

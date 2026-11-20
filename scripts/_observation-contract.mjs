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
// Contract shape (one object per geo-anchored observation; aligned with the
// canonical JSON Schema schemas/intelligence_contract_v1.json — the committed
// copy of KnockAI/Omega's cross-repo contract, see that file's header and
// tests/observation-contract-schema.test.mjs for provenance):
//   {
//     contractVersion: 1,
//     target: { h3Cell, lat, lng, label },
//     observedAt, ingestedAt, asOf,            // ISO8601, observedAt <= ingestedAt <= asOf
//     availability: { state, detail },         // AVAILABLE|STALE|MISSING|UNAVAILABLE|BLOCKED_BY_RIGHTS
//     provenance: { sourceId, sourceName, evidenceRefs, license, rightsState, authorization },
//     classification: 'LIVE' | 'SYNTHETIC',
//     signals: [ { id, type, value, unit, derived, observedAt } ],
//     riskIndex: { value, calibrationState, confidence, semantics },
//     hypotheses: [ ... ],
//     gaps: [ '...' ]
//   }
//
// RAW vs DERIVED (signals[].derived — the canonical contract requires the flag
// on every signal, and its value must be a finite number):
//   RAW (derived:false) — direct feed-measured facts, forwarded verbatim:
//     - a presence signal (value 1): the feed carries exactly one such record
//       for this target after dedup. A missing record is the absence of the
//       observation itself, never a zero-valued signal.
//     - AIS SOG/COG/true heading/AIS ship-type codes: verbatim numbers with
//       ITU-R M.1371 not-available sentinels filtered into gaps.
//   DERIVED (derived:true) — numeric intelligence computed/normalized beyond a
//     direct measurement, with the derivation semantics pinned in this file:
//     - weather.alert.severity_rank: CAP severity ladder
//       {Unknown:0, Minor:1, Moderate:2, Severe:3, Extreme:4}
//     - weather.alert.urgency_rank: CAP urgency ladder
//       {Past:0, Unknown:0, Future:1, Expected:2, Immediate:3}
//     - weather.alert.certainty_rank: CAP certainty ladder
//       {Unknown:0, Unlikely:0, Possible:1, Likely:2, Observed:3}
//     - infra.outage.severity_rank: Radar scope ladder derived from
//       mapOutageSeverity in scripts/seed-internet-outages.mjs
//       {OUTAGE_SEVERITY_PARTIAL:1, OUTAGE_SEVERITY_MAJOR:2,
//        OUTAGE_SEVERITY_TOTAL:3}
//     Unmapped or missing categorical values emit NO rank signal (fail-closed
//     gap note) — an unmapped category never becomes a fabricated rank.
//   Categorical identity (event names, VTEC strings, outage type/cause,
//   country) is not numeric, so it is carried by target.label and
//   provenance.evidenceRefs, never as a string-valued signal.
//
// POINT-IN-TIME ORDERING (fail-closed, matching the canonical contract's
// invariants (1) ingestedAt >= observedAt and (2) asOf >= ingestedAt):
//   - observedAt <= ingestedAt <= asOf on EVERY emitted observation;
//     ISO strings are normalized to UTC before comparison.
//   - asOf defaults to ingestedAt (the observation set is valid as of
//     ingestion); an explicit opts.asOf earlier than ingestedAt fails the
//     whole feed closed to UNAVAILABLE.
//   - Records whose own measurement timestamp postdates ingestion (AIS position
//     report timestamp, outage detectedAt) are dropped into `skipped` with the
//     violation as the reason — never emitted.
//   - Weather alert onset/expires are EVENT timing, not observation timing: a
//     warning issued now for a storm starting tomorrow is observed now. The
//     observedAt anchor chain is onset (when already past) -> seed fetchedAt
//     (when the fabric observed the alert) -> ingestedAt, each fallback
//     documented in a gap note. A future onset therefore never manufactures an
//     ordering violation.
//
// RISK INDEX / HYPOTHESES (brain-side, schema-required): the canonical schema
// requires riskIndex and hypotheses on every payload, so observations carry the
// brain-neutral form — riskIndex { value: null, calibrationState:
// 'UNCALIBRATED', confidence: 0, semantics: 'heuristic' } (exactly the
// canonical Python consumer's default factory) and hypotheses: [] — plus a gap
// noting the deferral. The OMEGA brain replaces both when it composes an
// intelligence response; the ingestion layer never invents a risk value. This
// is the documented observation-form subset: everything else validates against
// the full canonical schema as-is (tests/observation-contract-schema.test.mjs).
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
// never fabricated. Individual records that cannot be geo-anchored, whose
// provenance is unresolvable, or whose timestamps violate point-in-time
// ordering are skipped and reported in `skipped`, not invented.

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

// Derivation ladders (derived:true signals). Pinned here so tests and the
// contract doc can assert the exact semantics; see the module header.
export const WEATHER_SEVERITY_RANKS = Object.freeze({
  Unknown: 0,
  Minor: 1,
  Moderate: 2,
  Severe: 3,
  Extreme: 4,
});

export const CAP_URGENCY_RANKS = Object.freeze({
  Past: 0,
  Unknown: 0,
  Future: 1,
  Expected: 2,
  Immediate: 3,
});

export const CAP_CERTAINTY_RANKS = Object.freeze({
  Unknown: 0,
  Unlikely: 0,
  Possible: 1,
  Likely: 2,
  Observed: 3,
});

export const OUTAGE_SEVERITY_RANKS = Object.freeze({
  OUTAGE_SEVERITY_PARTIAL: 1,
  OUTAGE_SEVERITY_MAJOR: 2,
  OUTAGE_SEVERITY_TOTAL: 3,
});

// Brain-side riskIndex placeholder: the exact shape the canonical Python
// consumer (KnockAI/Omega scoring/app/intelligence_contract.py) uses as its
// RiskIndex default factory. The observation layer defers scoring to the brain.
export const BRAIN_NEUTRAL_RISK_INDEX = Object.freeze({
  value: null,
  calibrationState: 'UNCALIBRATED',
  confidence: 0,
  semantics: 'heuristic',
});

const RISK_INDEX_DEFERRAL_GAP =
  'riskIndex not computed at the ingestion layer — brain-side (value null, UNCALIBRATED, heuristic until the OMEGA brain scores)';

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

/** Point-in-time ordering: all three are UTC-normalized ISO strings. */
function satisfiesPointInTime({ observedAt, ingestedAt, asOf }) {
  return (
    Date.parse(observedAt) <= Date.parse(ingestedAt) && Date.parse(ingestedAt) <= Date.parse(asOf)
  );
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

/**
 * Resolve the observation timestamp triple with point-in-time ordering
 * (observedAt <= ingestedAt <= asOf):
 *   - ingestedAt: explicit opts.ingestedAt, else now.
 *   - asOf: explicit opts.asOf, else ingestedAt (the observation set is valid
 *     as of ingestion — never the fabric's earlier fetch time, which would
 *     claim data entered OMEGA before it did).
 * Returns null when an explicit opts.asOf precedes ingestedAt — a point-in-time
 * violation the caller must fail closed on (no observation may be emitted with
 * post-asOf ingestion).
 */
function resolveTimestamps({ opts, seed, fallbackAsOf }) {
  const ingestedAt = toIsoTimestamp(opts.ingestedAt) ?? new Date().toISOString();
  const explicitAsOf = toIsoTimestamp(opts.asOf);
  if (explicitAsOf !== null && Date.parse(explicitAsOf) < Date.parse(ingestedAt)) {
    return null;
  }
  const asOf =
    explicitAsOf ??
    toIsoTimestamp(fallbackAsOf) ??
    ingestedAt;
  if (Date.parse(asOf) < Date.parse(ingestedAt)) {
    return null;
  }
  return { ingestedAt, asOf, seedFetchedAt: toIsoTimestamp(seed?.fetchedAt) ?? null };
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
  availability = { state: 'AVAILABLE', detail: 'observation present' },
  classification = 'LIVE',
  signals = [],
  gaps = [],
}) {
  if (
    !satisfiesPointInTime({ observedAt, ingestedAt, asOf }) ||
    typeof h3Cell !== 'string' ||
    h3Cell.length === 0 ||
    typeof label !== 'string' ||
    label.length === 0
  ) {
    return null;
  }
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
    riskIndex: BRAIN_NEUTRAL_RISK_INDEX,
    hypotheses: [],
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

/**
 * Build a signal. `derived` is caller-owned and MUST reflect whether the value
 * is a direct feed measurement (false) or computed/normalized intelligence
 * (true) — the canonical contract rejects signals without the flag, and the
 * value must be a finite number (categorical strings are not signals).
 */
function buildSignal({ id, type, value, unit, derived = false, observedAt }) {
  return { id, type, value, unit, derived, observedAt };
}

/**
 * Append a derived ordinal-rank signal when the categorical value maps to the
 * ladder; otherwise append a fail-closed gap note. Never fabricates a rank
 * for an unmapped category.
 */
function pushRankSignal({ signals, gaps, id, type, category, ranks, observedAt }) {
  if (typeof category !== 'string' || category.length === 0) {
    gaps.push(`${id} missing — no ${type} signal emitted`);
    return;
  }
  const rank = ranks[category];
  if (typeof rank !== 'number') {
    gaps.push(`${id} '${category}' not in the documented ${type} ladder — no rank signal emitted`);
    return;
  }
  signals.push(
    buildSignal({ id, type, value: rank, unit: 'ordinal', derived: true, observedAt }),
  );
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
 * Resolve the observation timestamp for a weather alert. Onset/expires are
 * EVENT timing (a warning issued now can be for a storm starting tomorrow), so
 * a future onset must not manufacture a point-in-time violation: anchor to the
 * fabric fetch time, then ingestion time, with gap notes documenting each
 * fallback. See the module header (POINT-IN-TIME ORDERING).
 */
function resolveWeatherObservedAt({ alert, ingestedAt, seedFetchedAt }) {
  const gaps = [];
  const onset = toIsoTimestamp(alert.onset);
  if (onset !== null && Date.parse(onset) <= Date.parse(ingestedAt)) {
    return { observedAt: onset, gaps };
  }
  if (onset !== null) {
    gaps.push(
      `event onset ${onset} is after ingestion — event timing, not observation timing; observedAt anchored to the fabric observation instead`,
    );
  }
  if (seedFetchedAt !== null && Date.parse(seedFetchedAt) <= Date.parse(ingestedAt)) {
    return { observedAt: seedFetchedAt, gaps };
  }
  gaps.push('onset/expires unusable as observation time — observedAt fell back to ingestion time');
  return { observedAt: ingestedAt, gaps };
}

/**
 * Normalize the `weather:alerts:v1` canonical payload into contract
 * observations. Accepts the bare payload or the { _seed, data } seed
 * envelope (the envelope's `fetchedAt` is preserved as an evidenceRef and as
 * the observedAt anchor when an alert's own event timing is unusable).
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

  const resolved = resolveTimestamps({ opts, seed: _seed, fallbackAsOf: null });
  if (resolved === null) {
    return failClosedResult(
      `asOf precedes ingestedAt — point-in-time violation (asOf ${toIsoTimestamp(opts.asOf)}, ingestedAt ${toIsoTimestamp(opts.ingestedAt) ?? 'now'}); no observation may carry post-asOf ingestion`,
    );
  }
  const { ingestedAt, asOf, seedFetchedAt } = resolved;
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
      detail:
        data.alerts.length === 0
          ? 'zero active alerts (valid quiet state)'
          : `${data.alerts.length} active alert record(s) in the canonical payload`,
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
    const { observedAt, gaps: observedAtGaps } = resolveWeatherObservedAt({
      alert,
      ingestedAt,
      seedFetchedAt,
    });
    gaps.push(...observedAtGaps);
    if (alert.geometryPrecision === 'country') {
      gaps.push('centroid at country precision (geometryPrecision=country) — coarse geo anchor');
    } else if (alert.geometryPrecision === 'point') {
      gaps.push('centroid at point precision (geometryPrecision=point)');
    }

    // RAW presence (derived:false): one active alert record at this target.
    const signals = [
      buildSignal({ id: 'active', type: 'weather.alert.active', value: 1, unit: 'presence', derived: false, observedAt }),
    ];
    // DERIVED ordinal ranks (derived:true) — documented ladders, fail-closed
    // on unmapped categories. Event/urgency/certainty text is categorical
    // identity: it rides target.label + evidenceRefs, not signals.
    pushRankSignal({
      signals,
      gaps,
      id: 'severityRank',
      type: 'weather.alert.severity_rank',
      category: alert.severity,
      ranks: WEATHER_SEVERITY_RANKS,
      observedAt,
    });
    if (typeof alert.urgency === 'string' && alert.urgency) {
      pushRankSignal({
        signals,
        gaps,
        id: 'urgencyRank',
        type: 'weather.alert.urgency_rank',
        category: alert.urgency,
        ranks: CAP_URGENCY_RANKS,
        observedAt,
      });
    }
    if (typeof alert.certainty === 'string' && alert.certainty) {
      pushRankSignal({
        signals,
        gaps,
        id: 'certaintyRank',
        type: 'weather.alert.certainty_rank',
        category: alert.certainty,
        ranks: CAP_CERTAINTY_RANKS,
        observedAt,
      });
    }

    const id = String(alert.id ?? '');
    const evidenceRefs = [id ? source.recordRef(id) : '', WEATHER_REDIS_KEY_REF];
    if (seedFetchedAt !== null) {
      evidenceRefs.push(`seed:fetchedAt:${seedFetchedAt}`);
    }
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
          evidenceRefs,
          license: source.license,
        }),
        availability,
        classification,
        signals,
        gaps: [...gaps, RISK_INDEX_DEFERRAL_GAP],
      }),
    );
  }

  return { availability, observations: observations.filter(Boolean), skipped };
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
 * heading, speed, course, timestamp } (timestamp epoch ms). The snapshot's
 * own build timestamp is preserved as an evidenceRef (provenance), not as
 * asOf — the observation set is valid as of ingestion.
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
      ? { state: 'AVAILABLE', detail: `AIS relay connected, ${vesselCount} tracked vessels` }
      : { state: 'STALE', detail: 'AIS upstream disconnected — serving retained vessel positions' };
  } else {
    availability = { state: 'MISSING', detail: 'relay snapshot reports zero tracked vessels' };
  }

  const resolved = resolveTimestamps({ opts, seed: null, fallbackAsOf: null });
  if (resolved === null) {
    return failClosedResult(
      `asOf precedes ingestedAt — point-in-time violation (asOf ${toIsoTimestamp(opts.asOf)}, ingestedAt ${toIsoTimestamp(opts.ingestedAt) ?? 'now'}); no observation may carry post-asOf ingestion`,
    );
  }
  const { ingestedAt, asOf } = resolved;
  const snapshotBuiltAt = toIsoTimestamp(snapshot.timestamp);
  const classification = resolveClassification(opts.classification);

  const observations = [];
  const skipped = [];
  const seenMmsi = new Set();
  const tankerReports = Array.isArray(snapshot.tankerReports) ? snapshot.tankerReports : [];
  const candidateReports = Array.isArray(snapshot.candidateReports) ? snapshot.candidateReports : [];

  const reportArrays = [
    { reports: tankerReports, originRef: 'relay:tankerReports' },
    { reports: candidateReports, originRef: 'relay:candidateReports' },
  ];

  for (const { reports, originRef } of reportArrays) {
    for (const report of reports) {
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
      if (observedAt === null) {
        observedAt = ingestedAt;
        gaps.push('position report timestamp missing — observedAt fell back to ingestion time');
      } else if (Date.parse(observedAt) > Date.parse(ingestedAt)) {
        skipped.push({
          id: mmsi,
          reason: `position report timestamp ${observedAt} is after ingestedAt ${ingestedAt} — point-in-time violation, dropped`,
        });
        continue;
      }

      // RAW measurements (derived:false): verbatim AIS numbers, sentinel-filtered.
      const signals = [
        buildSignal({ id: 'positionReport', type: 'vessel.position_report', value: 1, unit: 'presence', derived: false, observedAt }),
      ];
      if (typeof report.speed === 'number' && Number.isFinite(report.speed) && report.speed < AIS_SOG_UNAVAILABLE) {
        signals.push(buildSignal({ id: 'speed', type: 'vessel.speed_sog', value: report.speed, unit: 'kn', derived: false, observedAt }));
      } else if (report.speed === AIS_SOG_UNAVAILABLE) {
        gaps.push('SOG 102.3 kn — AIS not-available sentinel, no speed signal emitted');
      }
      if (typeof report.course === 'number' && Number.isFinite(report.course) && report.course < AIS_COG_UNAVAILABLE) {
        signals.push(buildSignal({ id: 'course', type: 'vessel.course_cog', value: report.course, unit: 'deg', derived: false, observedAt }));
      } else if (report.course === AIS_COG_UNAVAILABLE) {
        gaps.push('COG 360° — AIS not-available sentinel, no course signal emitted');
      }
      if (
        typeof report.heading === 'number' &&
        Number.isFinite(report.heading) &&
        report.heading !== AIS_HEADING_UNAVAILABLE
      ) {
        signals.push(buildSignal({ id: 'heading', type: 'vessel.heading_true', value: report.heading, unit: 'deg', derived: false, observedAt }));
      } else if (report.heading === AIS_HEADING_UNAVAILABLE) {
        gaps.push('true heading 511° — AIS not-available sentinel, no heading signal emitted');
      }
      if (typeof report.shipType === 'number' && Number.isFinite(report.shipType) && report.shipType > 0) {
        signals.push(
          buildSignal({ id: 'aisShipType', type: 'vessel.ais_ship_type', value: report.shipType, unit: 'ais-type-code', derived: false, observedAt }),
        );
      } else {
        gaps.push('AIS ship type unknown (no ShipStaticData frame cached for this MMSI)');
      }

      const evidenceRefs = [AIS_SNAPSHOT_REF, originRef, `aisstream:mmsi:${mmsi}`];
      if (snapshotBuiltAt !== null) {
        evidenceRefs.push(`relay:snapshot:built:${snapshotBuiltAt}`);
      }
      if (Number.isFinite(Number(snapshot.sequence))) {
        evidenceRefs.push(`relay:snapshot:seq:${snapshot.sequence}`);
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
            evidenceRefs,
            license: AIS_PROVENANCE_BASE.license,
          }),
          availability,
          classification,
          signals,
          gaps: [...gaps, RISK_INDEX_DEFERRAL_GAP],
        }),
      );
    }
  }

  return { availability, observations: observations.filter(Boolean), skipped };
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
 * scoped, so the H3 resolution is 7. detectedAt is the OBSERVATION time
 * (when Cloudflare detected the outage) — a detectedAt after ingestion is a
 * point-in-time violation and the record is dropped, not emitted.
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

  const resolved = resolveTimestamps({ opts, seed: _seed, fallbackAsOf: null });
  if (resolved === null) {
    return failClosedResult(
      `asOf precedes ingestedAt — point-in-time violation (asOf ${toIsoTimestamp(opts.asOf)}, ingestedAt ${toIsoTimestamp(opts.ingestedAt) ?? 'now'}); no observation may carry post-asOf ingestion`,
    );
  }
  const { ingestedAt, asOf, seedFetchedAt } = resolved;
  const classification = resolveClassification(opts.classification);

  const availability = {
    state: 'AVAILABLE',
    detail:
      data.outages.length === 0
        ? 'zero curated Radar outages in 28d window (normal sparse state)'
        : `${data.outages.length} curated Radar outage annotation(s) in the 28d window`,
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
    if (observedAt === null) {
      observedAt = ingestedAt;
      gaps.push('detectedAt missing or unparsable — observedAt fell back to ingestion time');
    } else if (Date.parse(observedAt) > Date.parse(ingestedAt)) {
      skipped.push({
        id: String(outage.id ?? ''),
        reason: `detectedAt ${observedAt} is after ingestedAt ${ingestedAt} — point-in-time violation, dropped`,
      });
      continue;
    }
    const endedAt = toIsoTimestamp(outage.endedAt);
    if (endedAt) {
      gaps.push(`outage reported ended at ${endedAt} — retained within the Radar 28d annotation window`);
    }

    // RAW presence (derived:false): one active outage annotation at this target.
    // DERIVED severity rank: the Radar scope ladder from mapOutageSeverity in
    // scripts/seed-internet-outages.mjs. outageType/cause text is categorical
    // identity: it rides target.label + evidenceRefs, not signals.
    const signals = [
      buildSignal({ id: 'active', type: 'infra.outage.active', value: 1, unit: 'presence', derived: false, observedAt }),
    ];
    pushRankSignal({
      signals,
      gaps,
      id: 'severityRank',
      type: 'infra.outage.severity_rank',
      category: outage.severity,
      ranks: OUTAGE_SEVERITY_RANKS,
      observedAt,
    });

    const id = String(outage.id ?? '');
    const link = typeof outage.link === 'string' && /^https?:\/\//.test(outage.link) ? outage.link : '';
    const evidenceRefs = [id ? `cloudflare-radar:annotation:${id}` : '', link, OUTAGES_REDIS_KEY_REF];
    if (seedFetchedAt !== null) {
      evidenceRefs.push(`seed:fetchedAt:${seedFetchedAt}`);
    }
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
          evidenceRefs,
          license: OUTAGE_PROVENANCE_BASE.license,
        }),
        availability,
        classification,
        signals,
        gaps: [...gaps, RISK_INDEX_DEFERRAL_GAP],
      }),
    );
  }

  return { availability, observations: observations.filter(Boolean), skipped };
}

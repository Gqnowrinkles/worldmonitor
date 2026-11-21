// Canonical observation ingestion contract (v1) — normalizer tests.
//
// Fixtures under tests/fixtures/observation-contract/ carry REAL captured
// fabric shapes:
//   - weather-alerts.v1.json — captured 2026-11-20 from the production
//     fabric's `weather:alerts:v1` canonical key (OMEGA box redis-rest bridge),
//     trimmed to one alert per source (nws/eccc/swic). The { _seed, data }
//     envelope is the real seed envelope (state OK, recordCount 50).
//   - ais-snapshot.json — captured 2026-11-20 from the production ais-relay
//     `/ais/snapshot?tankers=true&candidates=true` response (sequence 19,
//     3637 tracked vessels); candidateReports trimmed to three records.
//   - internet-outages.v1.json — the `infra:outages:v1` key had expired on
//     the fabric at capture time (last-good seed-meta: recordCount 4), so
//     this fixture is built from the exact record construction in
//     scripts/seed-internet-outages.mjs (fetchOutages mapping) with
//     representative values; the values are synthetic, hence tests that use
//     it for content assertions pass classification 'SYNTHETIC'.
//
// H3 cell constants below are reference outputs of h3-js 4.4.0 (the pinned
// root dependency) and are additionally recomputed live in the final test so a
// library regression cannot silently keep them green.
//
// Schema-level compatibility (validation against the canonical JSON Schema
// copy in schemas/intelligence_contract_v1.json) lives in
// tests/observation-contract-schema.test.mjs; this file asserts the
// behavioral contract: raw/derived split, point-in-time ordering, fail-closed
// skips, and per-feed provenance.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import { describe, it } from 'node:test';

import { latLngToCell } from 'h3-js';

import {
  AVAILABILITY_STATES,
  BRAIN_NEUTRAL_RISK_INDEX,
  CAP_CERTAINTY_RANKS,
  CAP_URGENCY_RANKS,
  CONTRACT_VERSION,
  H3_RESOLUTIONS,
  OUTAGE_SEVERITY_RANKS,
  WEATHER_SEVERITY_RANKS,
  normalizeAisVesselReports,
  normalizeInternetOutages,
  normalizeWeatherAlerts,
} from '../scripts/_observation-contract.mjs';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/observation-contract/${name}`, import.meta.url), 'utf8'));

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Deterministic timestamps for assertions.
const INGESTED_AT_MS = 1795200600000; // 2026-11-20T18:50:00.000Z
const INGESTED_AT_ISO = '2026-11-20T18:50:00.000Z';
const WEATHER_SEED_FETCHED_AT_ISO = '2026-11-20T18:48:42.283Z'; // real fixture _seed.fetchedAt
const AIS_SNAPSHOT_TIMESTAMP = '2026-11-20T18:53:17.380Z'; // real fixture snapshot timestamp
const AIS_REPORT_TS_MS = 1795200788794; // real FURE VICTORIA position report timestamp
// The real captured relay snapshot was built 18:53:17Z with position reports
// up to 18:53:18Z — realistic OMEGA ingestion of that snapshot happens AFTER
// the snapshot exists, so the AIS tests ingest at 18:55 (keeping every real
// report timestamp strictly before ingestion, per point-in-time ordering).
const AIS_INGESTED_AT_MS = 1795200900000; // 2026-11-20T18:55:00.000Z
const AIS_INGESTED_AT_ISO = '2026-11-20T18:55:00.000Z';

// Reference H3 cells (h3-js 4.4.0 outputs for the real fixture coordinates).
const H3_NWS_RES7 = '87448da74ffffff';
const H3_ECCC_RES7 = '87132051cffffff';
const H3_SWIC_RES7 = '8766e09b3ffffff';
const H3_TANKER_265061000_RES9 = '891f250f0d3ffff';
const H3_CAND_630001267_RES9 = '892f5aaa00bffff';
const H3_BRAZIL_RES7 = '87a8c8a26ffffff';
const H3_GABON_RES7 = '8782ad59bffffff';

function assertContractInvariants(observations) {
  for (const observation of observations) {
    assert.equal(observation.contractVersion, CONTRACT_VERSION);
    assert.ok(AVAILABILITY_STATES.includes(observation.availability.state));
    // availability.detail is minLength 1 in the canonical schema.
    assert.ok(typeof observation.availability.detail === 'string' && observation.availability.detail.length > 0);
    assert.match(observation.observedAt, ISO_LIKE);
    assert.match(observation.ingestedAt, ISO_LIKE);
    assert.match(observation.asOf, ISO_LIKE);
    // Point-in-time ordering: observedAt <= ingestedAt <= asOf (UTC strings).
    assert.ok(
      Date.parse(observation.observedAt) <= Date.parse(observation.ingestedAt),
      `observedAt ${observation.observedAt} must not precede... must be <= ingestedAt ${observation.ingestedAt}`,
    );
    assert.ok(
      Date.parse(observation.ingestedAt) <= Date.parse(observation.asOf),
      `ingestedAt ${observation.ingestedAt} must be <= asOf ${observation.asOf}`,
    );
    assert.equal(observation.provenance.rightsState, 'REVIEW');
    assert.equal(observation.provenance.authorization.outcome, 'ALLOWED');
    assert.ok(Array.isArray(observation.provenance.evidenceRefs) && observation.provenance.evidenceRefs.length > 0);
    // Brain-side fields: schema-required, brain-neutral at ingestion.
    assert.deepEqual(observation.riskIndex, BRAIN_NEUTRAL_RISK_INDEX);
    assert.deepEqual(observation.hypotheses, []);
    assert.ok(observation.gaps.some((g) => g.startsWith('riskIndex not computed')));
    for (const signal of observation.signals) {
      // RAW vs DERIVED: the flag must be an explicit boolean, and every signal
      // value must be a finite number (categorical text is not a signal).
      assert.equal(typeof signal.derived, 'boolean');
      assert.equal(typeof signal.value, 'number');
      assert.ok(Number.isFinite(signal.value));
      assert.match(signal.observedAt, ISO_LIKE);
      assert.ok(signal.id && signal.type && signal.unit);
      assert.ok(
        Date.parse(signal.observedAt) <= Date.parse(observation.ingestedAt),
        `signal observedAt ${signal.observedAt} must be <= ingestedAt ${observation.ingestedAt}`,
      );
    }
  }
}

function signalsById(observation) {
  return Object.fromEntries(observation.signals.map((s) => [s.id, s]));
}

describe('normalizeWeatherAlerts', () => {
  const payload = fixture('weather-alerts.v1.json');

  it('maps the real captured payload to contract observations', () => {
    const result = normalizeWeatherAlerts(payload, { ingestedAt: INGESTED_AT_MS });

    assert.equal(result.availability.state, 'AVAILABLE');
    assert.ok(result.availability.detail.includes('3 active alert record'));
    assert.equal(result.observations.length, 3);
    assert.deepEqual(result.skipped, []);
    assertContractInvariants(result.observations);

    const [nws, eccc, swic] = result.observations;
    assert.equal(nws.classification, 'LIVE');

    // NWS: GeoJSON-order centroid [lng, lat] → lat/lng split, res-7 cell.
    assert.equal(nws.target.h3Cell, H3_NWS_RES7);
    assert.equal(nws.target.lat, 29.827142857142857);
    assert.equal(nws.target.lng, -80.47571428571429);
    // onset '2026-11-20T13:34:00-05:00' normalizes to UTC (event already underway).
    assert.equal(nws.observedAt, '2026-11-20T18:34:00.000Z');
    assert.equal(nws.provenance.sourceId, 'nws-alerts');
    assert.equal(nws.provenance.sourceName, 'U.S. National Weather Service (api.weather.gov)');
    assert.ok(nws.provenance.evidenceRefs.includes(payload.data.alerts[0].id));
    assert.ok(nws.provenance.evidenceRefs.includes('redis:weather:alerts:v1'));
    assert.ok(nws.provenance.evidenceRefs.includes(`seed:fetchedAt:${WEATHER_SEED_FETCHED_AT_ISO}`));
    // RAW presence + DERIVED severity rank (real Special Marine Warning = Severe).
    const nwsSignals = signalsById(nws);
    assert.equal(nwsSignals.active.value, 1);
    assert.equal(nwsSignals.active.derived, false);
    assert.equal(nwsSignals.severityRank.value, WEATHER_SEVERITY_RANKS.Severe);
    assert.equal(nwsSignals.severityRank.derived, true);
    assert.equal(nwsSignals.severityRank.unit, 'ordinal');
    // Categorical text (event, VTEC) is not a string-valued signal.
    assert.equal(nws.signals.some((s) => typeof s.value === 'string'), false);

    // ECCC record: onset 2026-11-21T04:00Z is FUTURE relative to ingestion —
    // event timing, not observation timing, so observedAt anchors to the
    // fabric fetch time (seed fetchedAt), never after ingestedAt.
    assert.equal(eccc.target.h3Cell, H3_ECCC_RES7);
    assert.equal(eccc.provenance.sourceId, 'eccc-alerts');
    assert.equal(eccc.observedAt, WEATHER_SEED_FETCHED_AT_ISO);
    assert.ok(eccc.gaps.some((g) => g.includes('event onset') && g.includes('event timing')));
    assert.equal(signalsById(eccc).severityRank.value, WEATHER_SEVERITY_RANKS.Moderate);
    assert.ok(eccc.provenance.evidenceRefs[0].startsWith('https://api.weather.gc.ca/collections/weather-alerts/items/'));

    // SWIC record: onset already past + derived urgency/certainty ranks.
    assert.equal(swic.target.h3Cell, H3_SWIC_RES7);
    assert.equal(swic.provenance.sourceId, 'swic-alerts');
    assert.equal(swic.observedAt, '2026-11-20T16:00:02.000Z');
    assert.equal(signalsById(swic).severityRank.value, WEATHER_SEVERITY_RANKS.Extreme);
    assert.equal(signalsById(swic).urgencyRank.value, CAP_URGENCY_RANKS.Future);
    assert.equal(signalsById(swic).certaintyRank.value, CAP_CERTAINTY_RANKS.Likely);
    assert.ok(swic.gaps.some((g) => g.includes('geometryPrecision=country')));
  });

  it('defaults asOf to ingestedAt and honors an explicit later asOf', () => {
    const result = normalizeWeatherAlerts(payload, { ingestedAt: INGESTED_AT_MS });
    for (const observation of result.observations) {
      assert.equal(observation.ingestedAt, INGESTED_AT_ISO);
      // asOf defaults to ingestion time — the seed envelope's fetchedAt is
      // preserved as an evidenceRef, not claimed as the answer's point-in-time.
      assert.equal(observation.asOf, INGESTED_AT_ISO);
      assert.equal(observation.provenance.rightsState, 'REVIEW');
      assert.ok(observation.provenance.license.length > 0);
      assert.equal(observation.provenance.authorization.outcome, 'ALLOWED');
    }

    const explicit = normalizeWeatherAlerts(payload, {
      ingestedAt: INGESTED_AT_MS,
      asOf: '2026-11-20T19:05:00.000Z',
    });
    for (const observation of explicit.observations) {
      assert.equal(observation.asOf, '2026-11-20T19:05:00.000Z');
    }
  });

  it('fails closed to UNAVAILABLE when asOf precedes ingestedAt (point-in-time)', () => {
    const result = normalizeWeatherAlerts(payload, {
      ingestedAt: INGESTED_AT_MS,
      asOf: '2026-11-20T18:00:00.000Z', // 50 minutes BEFORE ingestion
    });
    assert.equal(result.availability.state, 'UNAVAILABLE');
    assert.ok(result.availability.detail.includes('asOf precedes ingestedAt'));
    assert.equal(result.observations.length, 0);
    assert.equal(result.skipped.length, 0);
  });

  it('accepts the asOf == ingestedAt boundary', () => {
    const result = normalizeWeatherAlerts(payload, { ingestedAt: INGESTED_AT_MS, asOf: INGESTED_AT_ISO });
    assert.equal(result.availability.state, 'AVAILABLE');
    assert.ok(result.observations.length > 0);
    assertContractInvariants(result.observations);
  });

  it('marks synthetic fixture use as SYNTHETIC when asked', () => {
    const result = normalizeWeatherAlerts(payload, { classification: 'SYNTHETIC' });
    for (const observation of result.observations) {
      assert.equal(observation.classification, 'SYNTHETIC');
    }
  });

  it('reports STALE when the fabric published a degraded source state', () => {
    const degraded = {
      ...payload.data,
      sourceState: 'degraded',
      errorCode: 'WEATHER_ALERT_SOURCE_INCOMPLETE',
      failedSources: ['nws'],
      skipReason: 'nws-unavailable',
    };
    const result = normalizeWeatherAlerts(degraded, { ingestedAt: INGESTED_AT_MS });
    assert.equal(result.availability.state, 'STALE');
    assert.ok(result.availability.detail.includes('nws'));
    for (const observation of result.observations) {
      assert.equal(observation.availability.state, 'STALE');
    }
  });

  it('skips alerts that cannot be geo-anchored or attributed, without fabricating', () => {
    const data = {
      alerts: [
        payload.data.alerts[0],
        { ...payload.data.alerts[1], centroid: undefined },
        { ...payload.data.alerts[2], source: 'unknown-bureau' },
        { ...payload.data.alerts[2], centroid: [Number.NaN, 4.5] },
      ],
    };
    const result = normalizeWeatherAlerts(data, { ingestedAt: INGESTED_AT_MS });
    assert.equal(result.availability.state, 'AVAILABLE');
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].provenance.sourceId, 'nws-alerts');
    assert.equal(result.skipped.length, 3);
    assert.ok(result.skipped.every((s) => s.reason.length > 0));
  });

  it('emits no rank signal for a severity outside the documented ladder', () => {
    const data = { alerts: [{ ...payload.data.alerts[0], severity: 'Cataclysmic' }] };
    const result = normalizeWeatherAlerts(data, { ingestedAt: INGESTED_AT_MS });
    assert.equal(result.observations.length, 1);
    const observation = result.observations[0];
    assert.equal(observation.signals.some((s) => s.id === 'severityRank'), false);
    assert.ok(observation.gaps.some((g) => g.includes('severityRank') && g.includes('Cataclysmic')));
  });

  it('falls back to ingestion time when onset is unparsable and no seed fetchedAt exists', () => {
    const data = { alerts: [{ ...payload.data.alerts[0], onset: 'not-a-date', expires: '' }] };
    const result = normalizeWeatherAlerts(data, { ingestedAt: INGESTED_AT_MS });
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].observedAt, INGESTED_AT_ISO);
    assert.ok(result.observations[0].gaps.some((g) => g.includes('fell back to ingestion time')));
  });

  it('treats an empty alerts array as a valid quiet state', () => {
    const result = normalizeWeatherAlerts({ alerts: [] }, { ingestedAt: INGESTED_AT_MS });
    assert.equal(result.availability.state, 'AVAILABLE');
    assert.ok(result.availability.detail.includes('quiet'));
    assert.equal(result.observations.length, 0);
  });

  it('fails closed on unknown payload shapes', () => {
    for (const malformed of [null, undefined, 'alerts', 42, {}, { data: { alerts: 'nope' } }, { alerts: null }]) {
      const result = normalizeWeatherAlerts(malformed);
      assert.equal(result.availability.state, 'UNAVAILABLE', `expected UNAVAILABLE for ${JSON.stringify(malformed)}`);
      assert.ok(result.availability.detail.length > 0);
      assert.equal(result.observations.length, 0);
      assert.equal(result.skipped.length, 0);
    }
  });
});

describe('normalizeAisVesselReports', () => {
  const snapshot = fixture('ais-snapshot.json');

  it('maps the real captured relay snapshot to contract observations', () => {
    const result = normalizeAisVesselReports(snapshot, { ingestedAt: AIS_INGESTED_AT_MS });

    assert.equal(result.availability.state, 'AVAILABLE');
    // 6 real tankerReports + 3 trimmed candidateReports, no MMSI overlap.
    assert.equal(result.observations.length, 9);
    assert.deepEqual(result.skipped, []);
    assertContractInvariants(result.observations);

    const first = result.observations[0];
    // Real tanker FURE VICTORIA at 57.535575, 11.651919999999999 → res-9 cell.
    assert.equal(first.target.h3Cell, H3_TANKER_265061000_RES9);
    assert.equal(first.target.label, 'FURE VICTORIA');
    assert.equal(first.observedAt, new Date(AIS_REPORT_TS_MS).toISOString());
    assert.equal(first.classification, 'LIVE');
    assert.equal(first.provenance.sourceId, 'aisstream');
    assert.ok(first.provenance.evidenceRefs.includes('relay:/ais/snapshot'));
    assert.ok(first.provenance.evidenceRefs.includes('relay:tankerReports'));
    assert.ok(first.provenance.evidenceRefs.includes('aisstream:mmsi:265061000'));
    assert.ok(first.provenance.evidenceRefs.includes(`relay:snapshot:built:${AIS_SNAPSHOT_TIMESTAMP}`));
    assert.ok(first.provenance.evidenceRefs.includes('relay:snapshot:seq:19'));
    const byId = signalsById(first);
    // RAW presence + verbatim AIS measurements (derived:false).
    assert.equal(byId.positionReport.value, 1);
    assert.equal(byId.positionReport.derived, false);
    assert.equal(byId.speed.value, 4);
    assert.equal(byId.speed.derived, false);
    assert.equal(byId.course.value, 358.4);
    assert.equal(byId.heading.value, 0);
    assert.equal(byId.aisShipType.value, 80);

    const candidate = result.observations.find((o) => o.target.label === 'JINHUA 11');
    assert.ok(candidate);
    assert.equal(candidate.target.h3Cell, H3_CAND_630001267_RES9);
    assert.ok(candidate.provenance.evidenceRefs.includes('relay:candidateReports'));

    // asOf defaults to ingestion time (snapshot build time is provenance,
    // not the answer's point-in-time).
    for (const observation of result.observations) {
      assert.equal(observation.ingestedAt, AIS_INGESTED_AT_ISO);
      assert.equal(observation.asOf, AIS_INGESTED_AT_ISO);
    }
  });

  it('accepts the observedAt == ingestedAt boundary for position reports', () => {
    const result = normalizeAisVesselReports({
      sequence: 1,
      timestamp: AIS_SNAPSHOT_TIMESTAMP,
      status: { connected: true, vessels: 1, messages: 1, clients: 0, droppedMessages: 0 },
      tankerReports: [
        { mmsi: '111111111', name: 'BOUNDARY', lat: 1, lon: 2, timestamp: INGESTED_AT_MS },
      ],
    }, { ingestedAt: INGESTED_AT_MS });
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].observedAt, INGESTED_AT_ISO);
    assertContractInvariants(result.observations);
  });

  it('drops position reports whose timestamp postdates ingestion (point-in-time violation)', () => {
    const result = normalizeAisVesselReports({
      sequence: 2,
      timestamp: AIS_SNAPSHOT_TIMESTAMP,
      status: { connected: true, vessels: 2, messages: 2, clients: 0, droppedMessages: 0 },
      tankerReports: [
        // 1 ms after ingestedAt — beyond the boundary, fail-closed.
        { mmsi: '222222221', name: 'FUTURE', lat: 10, lon: 20, timestamp: INGESTED_AT_MS + 1 },
        { mmsi: '222222222', name: 'PAST', lat: 11, lon: 21, timestamp: INGESTED_AT_MS - 1 },
      ],
    }, { ingestedAt: INGESTED_AT_MS });
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].target.label, 'PAST');
    assert.equal(result.skipped.length, 1);
    assert.ok(result.skipped[0].reason.includes('point-in-time violation'));
  });

  it('fails closed to UNAVAILABLE when asOf precedes ingestedAt', () => {
    const result = normalizeAisVesselReports(snapshot, {
      ingestedAt: INGESTED_AT_MS,
      asOf: '2026-11-20T18:49:59.999Z',
    });
    assert.equal(result.availability.state, 'UNAVAILABLE');
    assert.ok(result.availability.detail.includes('asOf precedes ingestedAt'));
    assert.equal(result.observations.length, 0);
  });

  it('deduplicates vessel reports by MMSI with tankerReports precedence', () => {
    const report = { mmsi: '111111111', name: 'A', lat: 1, lon: 2, shipType: 84, speed: 1, course: 3, heading: 4, timestamp: 1795200000000 };
    const candidate = { ...report, name: 'B', lat: 3, lon: 4, timestamp: 1795200001000 };
    const result = normalizeAisVesselReports({
      sequence: 2,
      timestamp: AIS_SNAPSHOT_TIMESTAMP,
      status: { connected: true, currentPositionReady: true, vessels: 2, messages: 10, clients: 0, droppedMessages: 0 },
      disruptions: [],
      density: [],
      tankerReports: [report],
      candidateReports: [candidate],
    }, { ingestedAt: AIS_INGESTED_AT_MS });
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].target.label, 'A');
    assert.equal(result.observations[0].target.lat, 1);
  });

  it('filters AIS not-available sentinels into gaps, keeping the raw presence signal', () => {
    const result = normalizeAisVesselReports({
      sequence: 3,
      timestamp: AIS_SNAPSHOT_TIMESTAMP,
      status: { connected: true, vessels: 1, messages: 1, clients: 0, droppedMessages: 0 },
      tankerReports: [
        { mmsi: '222222222', name: 'SENTINEL', lat: 10, lon: 20, heading: 511, speed: 102.3, course: 360, timestamp: 1795200000000 },
      ],
    }, { ingestedAt: AIS_INGESTED_AT_MS });
    assert.equal(result.observations.length, 1);
    const observation = result.observations[0];
    // The position report itself is still a raw measured fact (presence 1);
    // only the sentinel-valued SOG/COG/heading become gaps.
    assert.deepEqual(observation.signals.map((s) => s.id), ['positionReport']);
    assert.ok(observation.gaps.some((g) => g.includes('SOG 102.3')));
    assert.ok(observation.gaps.some((g) => g.includes('COG 360')));
    assert.ok(observation.gaps.some((g) => g.includes('heading 511')));
  });

  it('reports STALE when the AIS upstream is disconnected with retained positions', () => {
    const disconnected = { ...snapshot, status: { ...snapshot.status, connected: false } };
    const result = normalizeAisVesselReports(disconnected, { ingestedAt: AIS_INGESTED_AT_MS });
    assert.equal(result.availability.state, 'STALE');
    assert.ok(result.availability.detail.includes('disconnected'));
    assert.equal(result.observations.length, 9);
  });

  it('reports MISSING when the relay tracks zero vessels', () => {
    const empty = {
      ...snapshot,
      status: { ...snapshot.status, vessels: 0 },
      tankerReports: [],
      candidateReports: [],
    };
    const result = normalizeAisVesselReports(empty);
    assert.equal(result.availability.state, 'MISSING');
    assert.equal(result.observations.length, 0);
  });

  it('skips reports without mmsi or finite coordinates', () => {
    const result = normalizeAisVesselReports({
      sequence: 4,
      timestamp: AIS_SNAPSHOT_TIMESTAMP,
      status: { connected: true, vessels: 3, messages: 1, clients: 0, droppedMessages: 0 },
      tankerReports: [
        { mmsi: '', name: 'NO MMSI', lat: 1, lon: 2, timestamp: 1795200000000 },
        { mmsi: '333333333', name: 'BAD LAT', lat: 999, lon: 2, timestamp: 1795200000000 },
        snapshot.tankerReports[0],
      ],
    }, { ingestedAt: AIS_INGESTED_AT_MS });
    assert.equal(result.observations.length, 1);
    assert.equal(result.skipped.length, 2);
  });

  it('fails closed on unknown snapshot shapes', () => {
    for (const malformed of [null, 'snapshot', 42, {}, { status: {} }, { status: { vessels: 'many' } }]) {
      const result = normalizeAisVesselReports(malformed);
      assert.equal(result.availability.state, 'UNAVAILABLE', `expected UNAVAILABLE for ${JSON.stringify(malformed)}`);
      assert.ok(result.availability.detail.length > 0);
      assert.equal(result.observations.length, 0);
    }
  });
});

describe('normalizeInternetOutages', () => {
  const payload = fixture('internet-outages.v1.json');

  it('maps outage annotations to contract observations', () => {
    // Values in this fixture are synthetic (prod key expired at capture time).
    const result = normalizeInternetOutages(payload, { ingestedAt: INGESTED_AT_MS, classification: 'SYNTHETIC' });

    assert.equal(result.availability.state, 'AVAILABLE');
    assert.equal(result.observations.length, 2);
    assert.deepEqual(result.skipped, []);
    assertContractInvariants(result.observations);

    const [brazil, gabon] = result.observations;
    assert.equal(brazil.classification, 'SYNTHETIC');
    assert.equal(brazil.target.h3Cell, H3_BRAZIL_RES7);
    assert.equal(brazil.target.lat, -14.24);
    assert.equal(brazil.target.lng, -51.93);
    assert.equal(brazil.observedAt, new Date(1795036800000).toISOString());
    assert.equal(brazil.provenance.sourceId, 'cloudflare-radar');
    assert.ok(brazil.provenance.license.includes('CC BY-NC 4.0'));
    assert.ok(brazil.provenance.evidenceRefs.includes('redis:infra:outages:v1'));
    assert.ok(brazil.provenance.evidenceRefs.some((ref) => ref.startsWith('cloudflare-radar:annotation:cf-')));
    const brazilSignals = signalsById(brazil);
    // RAW presence + DERIVED Radar scope rank (REGIONAL → MAJOR).
    assert.equal(brazilSignals.active.value, 1);
    assert.equal(brazilSignals.active.derived, false);
    assert.equal(brazilSignals.severityRank.value, OUTAGE_SEVERITY_RANKS.OUTAGE_SEVERITY_MAJOR);
    assert.equal(brazilSignals.severityRank.derived, true);
    // Categorical identity (type/cause) is not string-valued signals.
    assert.equal(brazil.signals.some((s) => typeof s.value === 'string'), false);
    // endedAt present → gap notes the retention window.
    assert.ok(brazil.gaps.some((g) => g.startsWith('outage reported ended at')));

    assert.equal(gabon.target.h3Cell, H3_GABON_RES7);
    assert.equal(signalsById(gabon).severityRank.value, OUTAGE_SEVERITY_RANKS.OUTAGE_SEVERITY_TOTAL);
    assert.equal(gabon.gaps.some((g) => g.startsWith('outage reported ended at')), false);
  });

  it('drops outages whose detectedAt postdates ingestion (point-in-time violation)', () => {
    const data = {
      outages: [
        payload.data.outages[0],
        { ...payload.data.outages[1], detectedAt: INGESTED_AT_MS + 60000 },
      ],
    };
    const result = normalizeInternetOutages(data, { ingestedAt: INGESTED_AT_MS });
    assert.equal(result.observations.length, 1);
    assert.equal(result.skipped.length, 1);
    assert.ok(result.skipped[0].reason.includes('point-in-time violation'));
  });

  it('fails closed to UNAVAILABLE when asOf precedes ingestedAt', () => {
    const result = normalizeInternetOutages(payload, {
      ingestedAt: INGESTED_AT_MS,
      asOf: '2026-11-20T18:49:00.000Z',
    });
    assert.equal(result.availability.state, 'UNAVAILABLE');
    assert.ok(result.availability.detail.includes('asOf precedes ingestedAt'));
    assert.equal(result.observations.length, 0);
  });

  it('emits no rank signal for a severity outside the documented ladder', () => {
    const data = { outages: [{ ...payload.data.outages[0], severity: 'OUTAGE_SEVERITY_WILD' }] };
    const result = normalizeInternetOutages(data, { ingestedAt: INGESTED_AT_MS });
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].signals.some((s) => s.id === 'severityRank'), false);
    assert.ok(result.observations[0].gaps.some((g) => g.includes('OUTAGE_SEVERITY_WILD')));
  });

  it('treats an empty outages array as a valid sparse state', () => {
    const result = normalizeInternetOutages({ outages: [] }, { ingestedAt: INGESTED_AT_MS });
    assert.equal(result.availability.state, 'AVAILABLE');
    assert.ok(result.availability.detail.includes('sparse'));
    assert.equal(result.observations.length, 0);
  });

  it('skips outages without a usable location', () => {
    const data = {
      outages: [
        payload.data.outages[0],
        { ...payload.data.outages[1], location: { latitude: null, longitude: 11.61 } },
      ],
    };
    const result = normalizeInternetOutages(data, { ingestedAt: INGESTED_AT_MS });
    assert.equal(result.observations.length, 1);
    assert.equal(result.skipped.length, 1);
  });

  it('fails closed on unknown payload shapes', () => {
    for (const malformed of [null, 'outages', [], { data: { outages: 4 } }, { outages: {} }]) {
      const result = normalizeInternetOutages(malformed);
      assert.equal(result.availability.state, 'UNAVAILABLE', `expected UNAVAILABLE for ${JSON.stringify(malformed)}`);
      assert.ok(result.availability.detail.length > 0);
      assert.equal(result.observations.length, 0);
    }
  });
});

describe('H3 derivation', () => {
  it('recomputes the reference cells from the fixture coordinates', () => {
    // Guards the hardcoded constants above against an h3-js behavior change:
    // the normalizer must agree with the pinned library on these exact inputs.
    assert.equal(latLngToCell(29.827142857142857, -80.47571428571429, H3_RESOLUTIONS.weatherAlerts), H3_NWS_RES7);
    assert.equal(latLngToCell(69.37027700000002, -124.02677200000001, H3_RESOLUTIONS.weatherAlerts), H3_ECCC_RES7);
    assert.equal(latLngToCell(4.570868, -74.297333, H3_RESOLUTIONS.weatherAlerts), H3_SWIC_RES7);
    assert.equal(latLngToCell(57.535575, 11.651919999999999, H3_RESOLUTIONS.maritimeVessel), H3_TANKER_265061000_RES9);
    assert.equal(latLngToCell(35.60061666666666, 139.96191666666667, H3_RESOLUTIONS.maritimeVessel), H3_CAND_630001267_RES9);
    assert.equal(latLngToCell(-14.24, -51.93, H3_RESOLUTIONS.infrastructureOutage), H3_BRAZIL_RES7);
    assert.equal(latLngToCell(-0.8, 11.61, H3_RESOLUTIONS.infrastructureOutage), H3_GABON_RES7);
    // Resolution contract: weather/infrastructure res 7, maritime res 9.
    assert.equal(H3_RESOLUTIONS.weatherAlerts, 7);
    assert.equal(H3_RESOLUTIONS.infrastructureOutage, 7);
    assert.equal(H3_RESOLUTIONS.maritimeVessel, 9);
  });
});

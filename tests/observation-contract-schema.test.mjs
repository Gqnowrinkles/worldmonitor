// Canonical observation contract v1 — OMEGA consumer compatibility tests.
//
// PROVENANCE of schemas/intelligence_contract_v1.json (the ONLY schema these
// tests validate against — no local re-interpretation):
//   - Source repo:  KnockAI/Omega
//   - Source ref:   branch feat/intelligence-contract-v1 = PR #7 head
//                  6c7e906a3d594d2af9e2eb666949b44ef6584c3c
//   - Git blob sha: e7696a457c3a99cdb9a52a2783777e40875a795a
//   - File sha256:  c2b04cc98e7d2181b218dc50b37933d4587111f9e6469a24e94a9afd6e5426a5
//                  (asserted below — a byte drift in the committed copy fails)
//   - Fetched:      2026-11-20 via the GitHub contents API; committed
//                  byte-identical. If PR #7 revises the schema, refresh the
//                  copy AND these constants deliberately, not silently.
//
// OBSERVATION-FORM SUBSET (documented deviation, schema-required fields):
// the canonical schema requires riskIndex and hypotheses on every payload —
// they are brain-side. Observations therefore carry the canonical Python
// consumer's own default-factory form: riskIndex { value: null,
// calibrationState: 'UNCALIBRATED', confidence: 0, semantics: 'heuristic' }
// and hypotheses: []. Everything else validates against the FULL canonical
// schema unchanged. The one consumer composite invariant that intentionally
// does not hold pre-brain is "AVAILABLE requires a non-null riskIndex.value"
// (enforced by scoring/app/intelligence_contract.py when the BRAIN composes a
// response — the ingestion layer never invents a risk value; the deferral is
// machine-readable as a gap on every observation).

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, it } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  normalizeAisVesselReports,
  normalizeInternetOutages,
  normalizeWeatherAlerts,
} from '../scripts/_observation-contract.mjs';

const SCHEMA_PATH = new URL('../schemas/intelligence_contract_v1.json', import.meta.url);
const EXPECTED_SCHEMA_SHA256 = 'c2b04cc98e7d2181b218dc50b37933d4587111f9e6469a24e94a9afd6e5426a5';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/observation-contract/${name}`, import.meta.url), 'utf8'));

// Real captured fabric snapshots need an ingestion time AFTER their capture
// (point-in-time: observedAt <= ingestedAt) — same constants as the
// behavioral suite.
const INGESTED_AT_MS = 1795200600000; // 2026-11-20T18:50:00.000Z (weather/outages)
const AIS_INGESTED_AT_MS = 1795200900000; // 2026-11-20T18:55:00.000Z (after the 18:53:17Z snapshot)

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function compileCanonicalSchema() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  // Repo idiom (see tests/china-corridor-openapi-contract.test.mjs). Format
  // keywords are annotations here; the date-time format is asserted explicitly
  // below so a non-ISO timestamp cannot slip through as schema-valid.
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  return { validate: ajv.compile(schema), schema };
}

function expectValid(validate, payload, label) {
  const ok = validate(payload);
  if (!ok) {
    assert.fail(
      `${label} must validate against the canonical schema; errors: ${JSON.stringify(validate.errors)}`,
    );
  }
}

function expectInvalid(validate, payload, label) {
  const ok = validate(payload);
  if (ok) {
    assert.fail(`${label} must be REJECTED by the canonical schema (negative control)`);
  }
}

function allObservations() {
  const weather = fixture('weather-alerts.v1.json');
  const ais = fixture('ais-snapshot.json');
  const outages = fixture('internet-outages.v1.json');
  const cases = [];
  const push = (label, result) => {
    for (const [index, observation] of result.observations.entries()) {
      cases.push({ label: `${label}[${index}]`, observation, result });
    }
  };

  push(
    'weather LIVE (real captured nws/eccc/swic alerts)',
    normalizeWeatherAlerts(weather, { ingestedAt: INGESTED_AT_MS }),
  );
  push(
    'weather SYNTHETIC',
    normalizeWeatherAlerts(weather, { ingestedAt: INGESTED_AT_MS, classification: 'SYNTHETIC' }),
  );
  push(
    'weather degraded (STALE)',
    normalizeWeatherAlerts(
      { ...weather.data, sourceState: 'degraded', failedSources: ['nws'], skipReason: 'nws-unavailable' },
      { ingestedAt: INGESTED_AT_MS },
    ),
  );
  push(
    'weather explicit asOf',
    normalizeWeatherAlerts(weather, { ingestedAt: INGESTED_AT_MS, asOf: '2026-11-20T19:05:00.000Z' }),
  );
  push(
    'ais LIVE (real captured relay snapshot)',
    normalizeAisVesselReports(ais, { ingestedAt: AIS_INGESTED_AT_MS }),
  );
  push(
    'ais SYNTHETIC',
    normalizeAisVesselReports(ais, { ingestedAt: AIS_INGESTED_AT_MS, classification: 'SYNTHETIC' }),
  );
  push(
    'ais sentinel-only vessel (gaps, presence signal)',
    normalizeAisVesselReports(
      {
        sequence: 3,
        timestamp: '2026-11-20T18:53:17.380Z',
        status: { connected: true, vessels: 1, messages: 1, clients: 0, droppedMessages: 0 },
        tankerReports: [
          { mmsi: '222222222', name: 'SENTINEL', lat: 10, lon: 20, heading: 511, speed: 102.3, course: 360, timestamp: 1795200000000 },
        ],
      },
      { ingestedAt: AIS_INGESTED_AT_MS },
    ),
  );
  push(
    'ais disconnected (STALE, retained positions)',
    normalizeAisVesselReports(
      { ...ais, status: { ...ais.status, connected: false } },
      { ingestedAt: AIS_INGESTED_AT_MS },
    ),
  );
  push(
    'outages SYNTHETIC (code-shaped fixture)',
    normalizeInternetOutages(outages, { ingestedAt: INGESTED_AT_MS, classification: 'SYNTHETIC' }),
  );
  push(
    'outages LIVE classification',
    normalizeInternetOutages(outages, { ingestedAt: INGESTED_AT_MS }),
  );
  push(
    'outages unmapped severity (fail-closed rank gap)',
    normalizeInternetOutages(
      { outages: [{ ...outages.data.outages[0], severity: 'OUTAGE_SEVERITY_WILD' }] },
      { ingestedAt: INGESTED_AT_MS },
    ),
  );
  return cases;
}

describe('canonical schema provenance', () => {
  it('the committed schema copy is byte-identical to KnockAI/Omega PR #7', () => {
    const bytes = readFileSync(SCHEMA_PATH);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256, EXPECTED_SCHEMA_SHA256);
  });
});

describe('every normalizer output validates against the canonical schema', () => {
  const { validate } = compileCanonicalSchema();

  it('validates every observation from every fixture and variant', () => {
    const cases = allObservations();
    assert.ok(cases.length >= 25, `expected a meaningful observation corpus, got ${cases.length}`);
    for (const { label, observation } of cases) {
      expectValid(validate, observation, label);
      // Explicit date-time format assert (format keywords are annotations in
      // the repo's ajv idiom): all three timestamps strict UTC ISO-8601.
      assert.match(observation.observedAt, ISO_LIKE, `${label} observedAt`);
      assert.match(observation.ingestedAt, ISO_LIKE, `${label} ingestedAt`);
      assert.match(observation.asOf, ISO_LIKE, `${label} asOf`);
      for (const [index, signal] of observation.signals.entries()) {
        assert.match(signal.observedAt, ISO_LIKE, `${label} signals[${index}].observedAt`);
      }
    }
  });

  it('pins the observation-form subset: brain-neutral riskIndex and empty hypotheses', () => {
    for (const { label, observation } of allObservations()) {
      assert.deepEqual(
        observation.riskIndex,
        { value: null, calibrationState: 'UNCALIBRATED', confidence: 0, semantics: 'heuristic' },
        label,
      );
      assert.deepEqual(observation.hypotheses, [], label);
      assert.ok(
        observation.gaps.some((gap) => gap.startsWith('riskIndex not computed')),
        `${label} must document the riskIndex deferral as a gap`,
      );
    }
  });

  it('raw/derived split: every signal carries an explicit boolean derived flag', () => {
    for (const { label, observation } of allObservations()) {
      for (const signal of observation.signals) {
        assert.equal(typeof signal.derived, 'boolean', `${label} signal ${signal.id}`);
        assert.equal(typeof signal.value, 'number', `${label} signal ${signal.id} value must be numeric`);
        assert.ok(Number.isFinite(signal.value), `${label} signal ${signal.id}`);
      }
    }
  });

  it('negative controls: the validator actually rejects contract violations', () => {
    const [sample] = allObservations();
    const clone = () => structuredClone(sample.observation);

    // Missing schema-required brain-side field.
    const noRiskIndex = clone();
    delete noRiskIndex.riskIndex;
    expectInvalid(validate, noRiskIndex, 'observation without riskIndex');

    // String-valued signal (categorical text is not a signal).
    const stringSignal = clone();
    stringSignal.signals.push({ id: 'bad', type: 'weather.alert.severity', value: 'Severe', unit: 'category', derived: false, observedAt: sample.observation.observedAt });
    expectInvalid(validate, stringSignal, 'string-valued signal');

    // derived flag missing / wrong type.
    const noDerived = clone();
    noDerived.signals[0] = { ...noDerived.signals[0] };
    delete noDerived.signals[0].derived;
    expectInvalid(validate, noDerived, 'signal without derived flag');

    // availability.detail is minLength 1.
    const emptyDetail = clone();
    emptyDetail.availability = { state: 'AVAILABLE', detail: '' };
    expectInvalid(validate, emptyDetail, 'empty availability.detail');

    // H3 cell pattern ^8[0-9a-f]{14}$.
    const badCell = clone();
    badCell.target.h3Cell = 'not-an-h3-cell';
    expectInvalid(validate, badCell, 'malformed h3Cell');

    // Unknown top-level property (additionalProperties: false).
    const extraProp = clone();
    extraProp.extraField = true;
    expectInvalid(validate, extraProp, 'unknown top-level field');

    // contractVersion must be exactly 1.
    const v2 = clone();
    v2.contractVersion = 2;
    expectInvalid(validate, v2, 'contractVersion 2');

    // riskIndex.value must be null or a 0..1 number when the brain scores it.
    const badRisk = clone();
    badRisk.riskIndex = { value: 7, calibrationState: 'UNCALIBRATED', confidence: 0, semantics: 'heuristic' };
    expectInvalid(validate, badRisk, 'riskIndex.value outside 0..1');
  });

  it('a brain-scored observation (the consumer-composed form) also validates', () => {
    // The observation-form subset defers riskIndex to the brain. When the
    // brain composes an AVAILABLE response it sets a calibrated-or-heuristic
    // index — that full-contract form must remain schema-valid too, proving
    // the ingestion subset is forward-compatible with the consumer's output.
    const [sample] = allObservations();
    const brainScored = structuredClone(sample.observation);
    brainScored.riskIndex = { value: 0.42, calibrationState: 'UNCALIBRATED', confidence: 0.4, semantics: 'heuristic' };
    brainScored.hypotheses = [
      { id: 'hyp-1', statement: 'Port calls may drop while the alert is active.', verified: false, impact: 'shipping' },
    ];
    expectValid(validate, brainScored, 'brain-scored observation');
  });
});

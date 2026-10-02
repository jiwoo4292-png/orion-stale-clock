'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/stale-clock');
const cli = require('../bin/orion-stale-clock');

const observed = '2026-09-29T09:46:05.402Z', ingested = '2026-09-29T09:46:12.309Z';
function study(id, completion = { date: '2026-08-31', type: 'ESTIMATED' }, changes = {}) {
  return { protocolSection: {
    identificationModule: { nctId: id },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Example public sponsor', class: 'INDUSTRY' } },
    designModule: { phases: ['PHASE3'] },
    statusModule: { overallStatus: 'NOT_YET_RECRUITING', primaryCompletionDateStruct: completion, startDateStruct: { date: '2026-08-31', type: 'ESTIMATED' }, lastUpdatePostDateStruct: { date: '2025-08-31' }, ...changes }
  } };
}
const projected = item => core.projectStudy(item, { observedAt: observed, ingestedAt: ingested });
const report = rows => core.classify(rows, { referenceDate: '2026-08-31', measuredAt: ingested });
function response(body, init = {}) { return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init }); }
function responses(items) { let index = 0; return async () => { assert.ok(index < items.length, 'unexpected fetch'); const result = items[index++]; return typeof result === 'function' ? result() : response(result); }; }
const version = { apiVersion: '2.0.5', dataTimestamp: '2026-09-28T15:02:03' };
const collection = items => core.collect({ fetchImpl: responses(items), clock: () => ingested, pageSize: 1, minRequestIntervalMs: 0 });

test('DAY/MONTH precision, leap years and invalid values are explicit', () => {
  assert.equal(core.dateInterval('2024-02').interval_end, '2024-02-29');
  assert.equal(core.dateInterval('2025-02').interval_end, '2025-02-28');
  assert.equal(core.dateInterval('2025-02-29').availability, 'UNAVAILABLE');
  assert.equal(core.dateInterval('2026').reason, 'UNSUPPORTED_YEAR');
  assert.equal(core.dateInterval(null).reason, 'MISSING');
  assert.equal(core.dateInterval({ date: '2026-08', precision: 'DAY' }).reason, 'PRECISION_MISMATCH');
  assert.equal(core.minusMonths('2024-02-29', 12), '2023-02-28');
  assert.equal(core.previousMonthEnd('2026-09-01'), '2026-08-31');
});
test('A and D are inclusive; a MONTH only qualifies after its whole interval', () => {
  const result = report([
    projected(study('NCT00000001')),
    projected(study('NCT00000002', { date: '2026-08', type: 'ESTIMATED' })),
    projected(study('NCT00000003', { date: '2026-09', type: 'ESTIMATED' })),
    projected(study('NCT00000004', { date: '2026-08-30', type: 'ACTUAL' }))
  ]);
  assert.equal(result.metrics.A.count, 2); assert.equal(result.metrics.D.count, 4);
  assert.equal(result.a_rows[0].days_after_estimated_date, 0); assert.equal(result.a_rows[1].days_after_estimated_date, null);
  assert.equal(result.wall.day_records, 1); assert.equal(result.wall.month_records_excluded, 1);
});
test('B and C recompute inclusive 12 calendar month thresholds', () => {
  const result = report([
    projected(study('NCT00000001', { date: '2025-08-31', type: 'ESTIMATED' })),
    projected(study('NCT00000002', { date: '2025-09-01', type: 'ESTIMATED' }, { lastUpdatePostDateStruct: { date: '2025-09-01' } }))
  ]);
  assert.equal(result.metrics.A.count, 2); assert.equal(result.metrics.B.count, 1); assert.equal(result.metrics.C.count, 1);
});
test('zero is measured but empty percentages are unavailable', () => {
  const result = report([]); assert.equal(result.metrics.A.count, 0); assert.equal(result.metrics.A.percentage, null);
  assert.equal(result.metrics.A.percentage_status, 'UNAVAILABLE_EMPTY_DENOMINATOR');
});
test('missing dates stay in population denominators and quality counts', () => {
  const result = report([projected(study('NCT00000001', null, { startDateStruct: null }))]);
  assert.equal(result.metrics.A.denominator, 1); assert.equal(result.metrics.D.denominator, 1);
  assert.equal(result.quality.date_fields.primary_completion.missing, 1);
});
test('combined Phase 2/3 qualifies for Phase 3, while pure Phase 2 does not', () => {
  const both = study('NCT00000001'), phase2 = study('NCT00000002');
  both.protocolSection.designModule.phases = ['PHASE2', 'PHASE3']; phase2.protocolSection.designModule.phases = ['PHASE2'];
  const result = report([projected(both), projected(phase2)]);
  assert.equal(result.population.records, 1); assert.equal(result.quality.excluded_filter_mismatches, 1);
  assert.equal(core.classify([projected(phase2)], { referenceDate: '2026-08-31', measuredAt: ingested, filters: { phases: ['PHASE2'] } }).population.records, 1);
});
test('replay ignores saved metric flags and rejects forged intervals and source URLs', () => {
  const record = { ...projected(study('NCT00000001')), metric_a: false, metric_b: false, metric_d: false };
  assert.equal(report([record]).metrics.A.count, 1);
  assert.throws(() => report([{ ...record, source_url: 'https://example.invalid/study' }]), { code: 'SNAPSHOT_SOURCE_URL_MISMATCH' });
  assert.throws(() => report([{ ...record, primary_completion: { ...record.primary_completion, interval_end: '2020-01-01' } }]), { code: 'SNAPSHOT_DATE_INTERVAL_MISMATCH' });
  assert.throws(() => report([record, record]), { code: 'DUPLICATE_NCT_ID' });
});
test('date-only posted time is not fabricated, actual observation is retained', () => {
  const record = projected(study('NCT00000001'));
  assert.equal(record.published_at, null); assert.equal(record.published_at_interval.value, '2025-08-31');
  assert.equal(record.first_seen_at, observed); assert.equal(record.ingested_at, ingested);
  assert.throws(() => core.classify([record], { referenceDate: '2026-09-30', measuredAt: ingested }), { code: 'REFERENCE_AFTER_OBSERVATION' });
});
test('documented query parameters are encoded and no arbitrary endpoint is exposed', () => {
  const url = new URL(core.studiesQuery({ condition: 'obesity', sponsor: 'Example & Company', phases: ['PHASE2', 'PHASE3'] }));
  assert.equal(url.origin, 'https://clinicaltrials.gov'); assert.equal(url.searchParams.get('query.cond'), 'obesity');
  assert.equal(url.searchParams.get('query.lead'), 'Example & Company'); assert.equal(url.searchParams.has('query.spons'), false);
  assert.equal(url.searchParams.get('filter.advanced'), '(AREA[Phase]PHASE2 OR AREA[Phase]PHASE3) AND AREA[LeadSponsorClass]INDUSTRY');
  assert.throws(() => core.studiesQuery({ phases: ['PHASE3] OR ALL'] }), { code: 'INVALID_PHASE_FILTER' });
  assert.throws(() => core.studiesQuery({ condition: 'NCT00000001' }), { code: 'NCT_ID_SEARCH_NOT_SUPPORTED' });
});
test('complete pagination, optional later-page totalCount and source calendar timezone', async () => {
  const result = await collection([version, { totalCount: 2, studies: [study('NCT00000001')], nextPageToken: 'a' }, { studies: [study('NCT00000002')] }, version]);
  assert.equal(result.population.records, 2); assert.equal(result.source.page_count, 2);
  assert.equal(result.reference_date, '2026-08-31'); assert.equal(result.source.version_before.reference_date_timezone, 'UNAVAILABLE');
  assert.equal(result.source.version_before.normalized_data_timestamp, null);
});
test('incomplete pagination fails, never silently truncates', async () => {
  await assert.rejects(core.collect({ fetchImpl: responses([version, { totalCount: 2, studies: [study('NCT00000001')], nextPageToken: 'a' }]), clock: () => ingested, pageSize: 1, maxPages: 1, minRequestIntervalMs: 0 }), { code: 'PAGINATION_LIMIT_REACHED' });
  await assert.rejects(collection([version, { totalCount: 2, studies: [study('NCT00000001')] }]), { code: 'SOURCE_TOTAL_MISMATCH' });
});
test('repeated tokens, duplicate IDs and empty successor pages are failures', async () => {
  await assert.rejects(collection([version, { totalCount: 3, studies: [study('NCT00000001')], nextPageToken: 'a' }, { studies: [study('NCT00000002')], nextPageToken: 'a' }]), { code: 'REPEATED_PAGE_TOKEN' });
  await assert.rejects(collection([version, { totalCount: 2, studies: [study('NCT00000001')], nextPageToken: 'a' }, { studies: [study('NCT00000001')] }]), { code: 'DUPLICATE_NCT_ID' });
  await assert.rejects(collection([version, { totalCount: 2, studies: [], nextPageToken: 'a' }]), { code: 'EMPTY_PAGE_WITH_SUCCESSOR' });
});
test('changed totals, changed source version and source-filter mismatches fail', async () => {
  await assert.rejects(collection([version, { totalCount: 2, studies: [study('NCT00000001')], nextPageToken: 'a' }, { totalCount: 3, studies: [study('NCT00000002')] }]), { code: 'SOURCE_TOTAL_CHANGED' });
  await assert.rejects(collection([version, { totalCount: 1, studies: [study('NCT00000001')] }, { ...version, dataTimestamp: '2026-09-29T15:02:03' }]), { code: 'SOURCE_VERSION_CHANGED' });
  const wrong = study('NCT00000001'); wrong.protocolSection.designModule.phases = ['PHASE2'];
  await assert.rejects(collection([version, { totalCount: 1, studies: [wrong] }]), { code: 'SOURCE_FILTER_MISMATCH' });
});
test('real collection defaults to sequential requests with conservative one-second spacing', async () => {
  const waits = [];
  const result = await core.collect({ fetchImpl: responses([version, { totalCount: 1, studies: [study('NCT00000001')] }, version]), clock: () => ingested, pageSize: 1, waitImpl: async value => { waits.push(value); } });
  assert.deepEqual(waits, [1000, 1000]); assert.equal(result.source.request_spacing_ms, 1000);
});
test('network errors, non-JSON, malformed JSON, redirects and size limits fail', async () => {
  await assert.rejects(core.readOfficial(async () => { throw new Error('private detail'); }, core.VERSION_URL), { code: 'SOURCE_REQUEST_UNAVAILABLE' });
  await assert.rejects(core.readOfficial(async () => response('{}', { headers: { 'content-type': 'text/html' } }), core.VERSION_URL), { code: 'SOURCE_CONTENT_TYPE_UNAVAILABLE' });
  await assert.rejects(core.readOfficial(async () => response('{'), core.VERSION_URL), { code: 'SOURCE_JSON_INVALID' });
  await assert.rejects(core.readOfficial(async () => ({ ...response({}), ok: true, redirected: true }), core.VERSION_URL), { code: 'SOURCE_REDIRECT_REFUSED' });
  await assert.rejects(core.readOfficial(async () => response({ large: 'abc' }), core.VERSION_URL, { maxBytes: 3 }), { code: 'SOURCE_RESPONSE_TOO_LARGE' });
  await assert.rejects(core.readOfficial(async () => response({}), 'https://example.invalid/api'), { code: 'NON_OFFICIAL_SOURCE_URL' });
});
test('CSV quotes formula-like public text, handles multiline strings, recomputes fields', () => {
  const record = projected(study('NCT00000001', { date: '2026-08', type: 'ESTIMATED' }));
  record.sponsor_name = '=SUM(1,2)\n"Example"';
  const csv = core.renderCsv(report([record])), result = core.parseCsv(Buffer.from(csv));
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].days_after_estimated_date, 'UNAVAILABLE');
  assert.ok(result.rows[0].sponsor_name.startsWith("'=SUM"));
  assert.throws(() => core.parseCsv(Buffer.from(csv.replace('"true"', '"false"'))), { code: 'CSV_DERIVED_FIELD_MISMATCH' });
});
test('CLI rejects unknown, duplicated, future or incompatible arguments without fetching', () => {
  assert.equal(cli.parseArguments(['--help']).help, true);
  assert.throws(() => cli.parseArguments(['measure', '--out', 'x', '--endpoint', 'https://example.invalid']), { code: 'UNKNOWN_OR_DUPLICATE_ARGUMENT' });
  assert.throws(() => cli.parseArguments(['measure', '--out', 'x', '--out', 'y']), { code: 'UNKNOWN_OR_DUPLICATE_ARGUMENT' });
  assert.throws(() => cli.parseArguments(['measure', '--out', 'x', '--reference-date', '2026-02-30']), { code: 'INVALID_REFERENCE_DATE' });
  assert.throws(() => cli.parseArguments(['reproduce', '--input', 'x', '--condition', 'obesity']), { code: 'ARGUMENT_NOT_SUPPORTED_FOR_COMMAND' });
});
test('reproduce and verify work offline; existing output cannot be overwritten', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-stale-clock-test-')); t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const out = path.join(temporary, 'first'), measured = report([projected(study('NCT00000001'))]);
  measured.source = { pagination_complete: true, source_version_stable: true };
  core.writeOutput(measured, out);
  const csv = path.join(out, 'data.csv'), snapshot = path.join(out, 'snapshot.json');
  const result = await cli.main(['reproduce', '--input', snapshot, '--compare-csv', csv], { fetchImpl: () => assert.fail('offline command must never fetch') });
  assert.equal(result.frozen_csv_byte_identity, true); assert.equal(result.metrics.A.count, 1);
  const verified = await cli.main(['verify', '--csv', csv, '--expected-sha256', result.csv_sha256]); assert.equal(verified.records, 1);
  await assert.rejects(cli.main(['verify', '--csv', csv, '--expected-sha256', '0'.repeat(64)]), { code: 'CSV_SHA256_MISMATCH' });
  assert.throws(() => core.writeOutput(measured, out), { code: 'OUTPUT_DIRECTORY_EXISTS' });
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')); assert.equal(manifest.files['data.csv'].sha256, result.csv_sha256);
});
test('measure failure creates no output directory or completed manifest', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-stale-clock-failure-')); t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, 'never-written');
  await assert.rejects(cli.main(['measure', '--out', output], { fetchImpl: async () => { throw new Error('offline'); } }), { code: 'SOURCE_REQUEST_UNAVAILABLE' });
  assert.equal(fs.existsSync(output), false);
});
test('distribution includes attribution, docs and fixed Docker COPY sources', () => {
  const root = path.resolve(__dirname, '..'), pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const name of ['LICENSE', 'LICENSE-DATA.md', 'NOTICE-SOURCES.md', 'METHODOLOGY.md', 'README.md', 'CONTRIBUTING.md', 'assets', 'test']) {
    assert.ok(pkg.files.includes(name)); assert.ok(fs.existsSync(path.join(root, name)));
  }
  assert.equal(Object.hasOwn(pkg.scripts, 'postinstall'), false);
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'), ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split(/\r?\n/);
  for (const line of docker.split(/\r?\n/).filter(line => line.startsWith('COPY '))) {
    for (const name of line.split(/\s+/).slice(1, -1)) {
      assert.ok(fs.existsSync(path.join(root, name)), name + ' exists');
      assert.ok(ignore.includes('!' + name) || ignore.includes('!' + name + '/'), name + ' is allowed by Docker context');
    }
  }
  assert.ok(docker.includes('USER node'));
});
test('frozen September 29 projection independently recreates approved counts and exact CSV bytes', () => {
  const directory = path.resolve(__dirname, '../data/2026-09-29');
  const snapshot = JSON.parse(fs.readFileSync(path.join(directory, 'snapshot.json'), 'utf8'));
  const frozen = fs.readFileSync(path.join(directory, 'data.csv'));
  const result = core.classify(snapshot.records, { referenceDate: snapshot.reference_date, measuredAt: snapshot.measured_at, source: snapshot.source });
  assert.equal(result.population.records, 3762);
  assert.deepEqual(Object.fromEntries(Object.entries(result.metrics).map(([key, metric]) => [key, metric.count])), { A: 377, B: 226, C: 82, D: 331 });
  assert.equal(result.metrics.D.denominator, 552);
  assert.deepEqual(result.wall, { day_records: 224, month_records_excluded: 153, combined_elapsed_days: 54361, combined_elapsed_years_divisor: 365.25, median_days: 153, longest_days: 2650 });
  assert.ok(frozen.equals(Buffer.from(core.renderCsv(result))));
  assert.equal(core.sha256(frozen), 'be429676b07fa0bd6077311c8368110b79bf43aadc9806c8d58fbf84a821cff5');
});

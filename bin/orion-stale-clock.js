#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/stale-clock');

const HELP = `ORION Stale Clock — current-state registry measurement

Node.js 22 or newer. No account, API key, database or AI API required.

Commands:
  reproduce --input snapshot.json [--compare-csv data.csv] [--out NEW_DIRECTORY]
  verify --csv data.csv [--expected-sha256 HEX]
  measure --out NEW_DIRECTORY [filters]

Filters for measure:
  --condition TEXT       Official query.cond; a search candidate set, not a diagnosis classifier
  --sponsor TEXT         Official query.lead; lead sponsor search, not parent-company matching
  --phase PHASE3         Comma-separated phase enums; Phase 3 includes combined Phase 2/3
  --status ENUMS         Default: four active statuses
  --sponsor-class VALUE  INDUSTRY (default) or ANY
  --reference-date DATE  YYYY-MM-DD; default prior month end of source calendar date
  --page-size N          1–1000; default 100
  --max-pages N          1–1000; default 100
  --max-records N        1–100000; default 20000

Reproduce reads local public projected fields and makes no network request.
It preserves original observation times and recomputes all metric flags.
Condition/sponsor searches require measure; the minimal snapshot lacks search fields.
Changing a reference date evaluates the same observed snapshot, never historical as_of.
An incomplete or changing API result fails without a completed output manifest.

Registered completion dates are not promises of results announcements.
`;

function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new core.ClockError('INVALID_ARGUMENTS');
  if (!argv.length || argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const command = argv[0];
  if (!['measure', 'reproduce', 'verify'].includes(command)) throw new core.ClockError('UNKNOWN_COMMAND');
  const values = {}, allowed = new Set(['input', 'out', 'compare-csv', 'csv', 'expected-sha256', 'condition', 'sponsor', 'phase', 'status', 'sponsor-class', 'reference-date', 'page-size', 'max-pages', 'max-records']);
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--help') return { help: true };
    if (typeof token !== 'string' || !token.startsWith('--')) throw new core.ClockError('UNKNOWN_ARGUMENT');
    const equal = token.indexOf('='), key = token.slice(2, equal < 0 ? undefined : equal);
    if (!allowed.has(key) || Object.hasOwn(values, key)) throw new core.ClockError('UNKNOWN_OR_DUPLICATE_ARGUMENT');
    const value = equal < 0 ? argv[++index] : token.slice(equal + 1);
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw new core.ClockError('ARGUMENT_VALUE_REQUIRED');
    values[key] = value;
  }
  const byCommand = {
    verify: new Set(['csv', 'expected-sha256']),
    reproduce: new Set(['input', 'out', 'compare-csv', 'phase', 'status', 'sponsor-class', 'reference-date']),
    measure: new Set(['out', 'condition', 'sponsor', 'phase', 'status', 'sponsor-class', 'reference-date', 'page-size', 'max-pages', 'max-records'])
  };
  if (Object.keys(values).some(key => !byCommand[command].has(key))) throw new core.ClockError('ARGUMENT_NOT_SUPPORTED_FOR_COMMAND');
  if (command === 'verify' && !values.csv || command === 'reproduce' && !values.input || command === 'measure' && !values.out) throw new core.ClockError('REQUIRED_ARGUMENT_MISSING');
  if (values['expected-sha256'] && !/^[a-f0-9]{64}$/.test(values['expected-sha256'])) throw new core.ClockError('INVALID_EXPECTED_SHA256');
  if (values['reference-date'] && !core.validDay(values['reference-date'])) throw new core.ClockError('INVALID_REFERENCE_DATE');
  const integer = (key, defaultValue, max) => {
    if (!Object.hasOwn(values, key)) return defaultValue;
    if (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(Number(values[key])) || Number(values[key]) < 1 || Number(values[key]) > max) throw new core.ClockError('INVALID_COLLECTION_LIMITS');
    return Number(values[key]);
  };
  const filters = {};
  if (values.phase) filters.phases = values.phase.split(',');
  if (values.status) filters.statuses = values.status.split(',');
  if (values['sponsor-class']) filters.leadSponsorClass = values['sponsor-class'];
  if (values.condition) filters.condition = values.condition;
  if (values.sponsor) filters.sponsor = values.sponsor;
  core.normalizeFilters(filters);
  return { command, values, filters, pageSize: integer('page-size', 100, 1000), maxPages: integer('max-pages', 100, 1000), maxRecords: integer('max-records', 20000, 100000) };
}
function readLocal(file) {
  const absolute = path.resolve(file), stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new core.ClockError('LOCAL_INPUT_TOO_LARGE_OR_NOT_FILE');
  return fs.readFileSync(absolute);
}
function summary(report) {
  return { status: report.status, measured_at: report.measured_at, reference_date: report.reference_date, population: report.population, metrics: report.metrics, wall: report.wall, quality: report.quality, csv_sha256: core.sha256(core.renderCsv(report)), notices: report.notices };
}
async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  if (options.help) return { help: HELP };
  const { command, values } = options;
  if (values.out && fs.existsSync(path.resolve(values.out))) throw new core.ClockError('OUTPUT_DIRECTORY_EXISTS');
  if (command === 'verify') {
    const bytes = readLocal(values.csv), result = core.parseCsv(bytes);
    if (values['expected-sha256'] && result.sha256 !== values['expected-sha256']) throw new core.ClockError('CSV_SHA256_MISMATCH');
    return {
      status: 'CSV_BYTES_AND_DERIVED_ROW_FIELDS_VERIFIED', sha256: result.sha256, records: result.rows.length,
      reference_date: result.reference_date, day_records: result.rows.filter(row => row.primary_completion_precision === 'DAY').length,
      month_records: result.rows.filter(row => row.primary_completion_precision === 'MONTH').length,
      metric_b: result.rows.filter(row => row.metric_b === 'true').length, metric_c: result.rows.filter(row => row.metric_c === 'true').length,
      population_and_metric_d: 'UNAVAILABLE_FROM_A_ONLY_CSV',
      proof_scope: 'Byte integrity and internally recomputed row fields; no external timestamp, source authenticity or completeness proof.'
    };
  }
  let report;
  if (command === 'measure') {
    report = await core.collect({ filters: options.filters, referenceDate: values['reference-date'] ?? null, pageSize: options.pageSize, maxPages: options.maxPages, maxRecords: options.maxRecords, ...dependencies });
  } else {
    let snapshot;
    try { snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readLocal(values.input))); }
    catch (error) { if (error instanceof core.ClockError) throw error; throw new core.ClockError('INVALID_LOCAL_SNAPSHOT_JSON'); }
    if (snapshot?.schema_version !== 1 || !Array.isArray(snapshot.records) || snapshot.source?.pagination_complete !== true || snapshot.source?.source_version_stable !== true) throw new core.ClockError('COMPLETE_LOCAL_SNAPSHOT_REQUIRED');
    const filters = { ...(snapshot.filters ?? {}), ...options.filters };
    if (filters.condition || filters.sponsor) {
      // The original query may define the saved snapshot, but cannot be rerun on its minimal fields.
      filters.condition = null; filters.sponsor = null;
    }
    report = core.classify(snapshot.records, { referenceDate: values['reference-date'] ?? snapshot.reference_date, measuredAt: snapshot.measured_at, filters, source: snapshot.source });
    if (values['compare-csv']) {
      const expected = readLocal(values['compare-csv']); core.parseCsv(expected);
      if (!expected.equals(Buffer.from(core.renderCsv(report), 'utf8'))) throw new core.ClockError('FROZEN_CSV_REPRODUCTION_MISMATCH');
    }
  }
  return { ...summary(report), ...(values['compare-csv'] ? { frozen_csv_byte_identity: true } : {}), ...(values.out ? { local_output: core.writeOutput(report, values.out) } : {}) };
}
if (require.main === module) {
  main().then(result => process.stdout.write(result.help ?? JSON.stringify(result, null, 2) + '\n')).catch(error => {
    // Keep raw response bodies, page tokens, paths and exception stacks out of CLI logs.
    process.stderr.write((error instanceof core.ClockError ? error.code : 'LOCAL_COMMAND_FAILED') + '\n'); process.exitCode = 1;
  });
}
module.exports = { parseArguments, main, HELP };

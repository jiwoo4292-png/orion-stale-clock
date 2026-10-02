'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STUDIES_URL = 'https://clinicaltrials.gov/api/v2/studies';
const VERSION_URL = 'https://clinicaltrials.gov/api/v2/version';
const POLICY_VERSION = 'stale-clock-v5-20260929-3';
const UNAVAILABLE = 'UNAVAILABLE';
const ACTIVE_STATUSES = Object.freeze(['RECRUITING', 'ACTIVE_NOT_RECRUITING', 'NOT_YET_RECRUITING', 'ENROLLING_BY_INVITATION']);
const ALLOWED_STATUSES = new Set([...ACTIVE_STATUSES, 'COMPLETED', 'TERMINATED', 'SUSPENDED', 'WITHDRAWN', 'UNKNOWN']);
const ALLOWED_PHASES = new Set(['EARLY_PHASE1', 'PHASE1', 'PHASE2', 'PHASE3', 'PHASE4', 'NA']);
const CSV_COLUMNS = Object.freeze([
  'nct_id', 'sponsor_name', 'overall_status', 'phases',
  'primary_completion_date', 'primary_completion_basis', 'primary_completion_precision',
  'primary_completion_interval_start', 'primary_completion_interval_end',
  'last_update_posted', 'last_update_posted_precision', 'last_update_posted_interval_end',
  'days_after_estimated_date', 'metric_b', 'metric_c', 'source_url',
  'reference_date', 'first_seen_at', 'ingested_at'
]);
const NOTICES = Object.freeze([
  'The checked record still lists this estimated date.',
  'Registered completion dates are not promises of results announcements.',
  'This is a current-state observation, not a version history or a historical as-of reconstruction.',
  'It is not a finding that any trial is delayed or out of compliance. Sponsors may update their records at any time.',
  'All four metrics use date interval end on or before the reference date; B and C apply an additional twelve-calendar-month cutoff.'
]);

class ClockError extends Error {
  constructor(code) { super(code); this.name = 'ClockError'; this.code = code; }
}
const fail = code => { throw new ClockError(code); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !validDay(value.slice(0, 10))) fail('INVALID_OBSERVATION_TIMESTAMP');
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59 || !Number.isFinite(Date.parse(value))) fail('INVALID_OBSERVATION_TIMESTAMP');
  const offset = value.match(/[+-](\d{2}):(\d{2})$/);
  if (offset && (Number(offset[1]) > 23 || Number(offset[2]) > 59)) fail('INVALID_OBSERVATION_TIMESTAMP');
  return new Date(value).toISOString();
}
function monthEnd(year, month) {
  const date = new Date(String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-01T00:00:00.000Z');
  date.setUTCMonth(date.getUTCMonth() + 1); date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
function previousMonthEnd(value) {
  if (!validDay(value)) fail('INVALID_REFERENCE_DATE');
  const date = new Date(value + 'T00:00:00.000Z'); date.setUTCDate(0);
  if (date.getUTCFullYear() < 1) fail('REFERENCE_DATE_OUT_OF_RANGE');
  return date.toISOString().slice(0, 10);
}
function minusMonths(value, months) {
  if (!validDay(value) || !Number.isSafeInteger(months) || months < 0) fail('INVALID_CALENDAR_CUTOFF');
  const date = new Date(value + 'T00:00:00.000Z'), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - months);
  if (date.getUTCFullYear() < 1) fail('REFERENCE_DATE_OUT_OF_RANGE');
  date.setUTCDate(Math.min(day, Number(monthEnd(date.getUTCFullYear(), date.getUTCMonth() + 1).slice(-2))));
  return date.toISOString().slice(0, 10);
}
function dateInterval(input, { requireBasis = false } = {}) {
  const value = typeof input === 'string' ? input : input?.value ?? input?.date;
  const rawBasis = input && typeof input === 'object' ? input.basis ?? input.type : undefined;
  const declared = input && typeof input === 'object' ? input.precision : undefined;
  let reason = null, precision = null, start = null, end = null;
  if (value === null || value === undefined || value === '') reason = 'MISSING';
  else if (typeof value !== 'string') reason = 'INVALID';
  else if (/^\d{4}$/.test(value)) { precision = 'YEAR'; reason = 'UNSUPPORTED_YEAR'; }
  else if (/^\d{4}-\d{2}$/.test(value)) {
    precision = 'MONTH';
    if (!validDay(value + '-01')) reason = 'INVALID';
    else { start = value + '-01'; end = monthEnd(Number(value.slice(0, 4)), Number(value.slice(5))); }
  } else if (validDay(value)) { precision = 'DAY'; start = end = value; }
  else reason = 'INVALID';
  if (!reason && declared !== undefined && declared !== precision) reason = 'PRECISION_MISMATCH';
  if (reason) start = end = null;
  const basisStatus = !requireBasis ? 'NOT_REQUIRED' : rawBasis === null || rawBasis === undefined || rawBasis === '' ? 'MISSING' : ['ESTIMATED', 'ACTUAL'].includes(rawBasis) ? 'AVAILABLE' : 'INVALID';
  return {
    value: typeof value === 'string' && value !== '' ? value : null,
    basis: typeof rawBasis === 'string' && rawBasis !== '' ? rawBasis : null,
    basis_status: basisStatus, precision, interval_start: start, interval_end: end,
    availability: reason ? UNAVAILABLE : 'AVAILABLE', reason
  };
}
function normalizeFilters(input = {}) {
  const phases = input.phases ?? ['PHASE3'], statuses = input.statuses ?? [...ACTIVE_STATUSES];
  if (!Array.isArray(phases) || !phases.length || phases.some(value => !ALLOWED_PHASES.has(value)) || new Set(phases).size !== phases.length) fail('INVALID_PHASE_FILTER');
  if (!Array.isArray(statuses) || !statuses.length || statuses.some(value => !ALLOWED_STATUSES.has(value)) || new Set(statuses).size !== statuses.length) fail('INVALID_STATUS_FILTER');
  const leadSponsorClass = input.leadSponsorClass ?? 'INDUSTRY';
  if (!['INDUSTRY', 'ANY'].includes(leadSponsorClass)) fail('INVALID_SPONSOR_CLASS_FILTER');
  const text = (value, field) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_' + field + '_QUERY');
    // A query made solely of NCT IDs can cause the official API to ignore filters.
    if (/^(?:NCT\d{8})(?:[ ,]+NCT\d{8})*$/i.test(value.trim())) fail('NCT_ID_SEARCH_NOT_SUPPORTED');
    return value.trim();
  };
  return { phases: [...phases], statuses: [...statuses], leadSponsorClass, condition: text(input.condition, 'CONDITION'), sponsor: text(input.sponsor, 'SPONSOR') };
}
function studiesQuery(filtersInput = {}, { pageSize = 100, pageToken = null } = {}) {
  const filters = normalizeFilters(filtersInput);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) fail('INVALID_PAGE_SIZE');
  const url = new URL(STUDIES_URL);
  url.searchParams.set('format', 'json'); url.searchParams.set('pageSize', String(pageSize)); url.searchParams.set('countTotal', 'true');
  url.searchParams.set('filter.overallStatus', filters.statuses.join(','));
  const phaseExpression = filters.phases.map(value => 'AREA[Phase]' + value).join(' OR ');
  url.searchParams.set('filter.advanced', '(' + phaseExpression + ')' + (filters.leadSponsorClass === 'ANY' ? '' : ' AND AREA[LeadSponsorClass]INDUSTRY'));
  if (filters.condition) url.searchParams.set('query.cond', filters.condition);
  // This is the documented lead sponsor search, not a parent-company identity match.
  if (filters.sponsor) url.searchParams.set('query.lead', filters.sponsor);
  if (pageToken !== null) {
    if (typeof pageToken !== 'string' || !pageToken || pageToken.length > 8192 || /[\u0000-\u001f\u007f]/.test(pageToken)) fail('INVALID_PAGE_TOKEN');
    url.searchParams.set('pageToken', pageToken);
  }
  return url.href;
}
function inPopulation(record, filters) {
  return (filters.leadSponsorClass === 'ANY' || record.lead_sponsor_class === filters.leadSponsorClass) && filters.statuses.includes(record.overall_status) && record.phases.some(value => filters.phases.includes(value));
}
function projectStudy(study, { observedAt, ingestedAt = observedAt } = {}) {
  const first = instant(observedAt), ingested = instant(ingestedAt);
  if (ingested < first) fail('INGESTED_BEFORE_OBSERVATION');
  const protocol = study?.protocolSection, id = protocol?.identificationModule?.nctId;
  if (!protocol || typeof id !== 'string' || !/^NCT\d{8}$/.test(id)) fail('MALFORMED_STUDY');
  const phases = protocol.designModule?.phases;
  if (!Array.isArray(phases) || phases.some(value => typeof value !== 'string')) fail('MALFORMED_PHASES');
  const status = protocol.statusModule || {}, sponsor = protocol.sponsorCollaboratorsModule?.leadSponsor || {};
  const posted = dateInterval(status.lastUpdatePostDateStruct);
  return {
    nct_id: id, sponsor_name: typeof sponsor.name === 'string' && sponsor.name.trim() ? sponsor.name : null,
    lead_sponsor_class: typeof sponsor.class === 'string' ? sponsor.class : null,
    overall_status: typeof status.overallStatus === 'string' ? status.overallStatus : null,
    phases: [...phases], primary_completion: dateInterval(status.primaryCompletionDateStruct, { requireBasis: true }),
    start_date: dateInterval(status.startDateStruct, { requireBasis: true }), last_update_posted: posted,
    source_url: 'https://clinicaltrials.gov/study/' + id, source_api_url: STUDIES_URL + '/' + id,
    comparison_method: 'CURRENT_STATE_ONLY', observation_channel: 'DIRECT_OFFICIAL_API',
    effective_at: null, effective_at_status: 'UNAVAILABLE_NOT_AN_EVENT',
    published_at: null, published_at_status: posted.availability === 'AVAILABLE' ? 'DATE_INTERVAL_ONLY' : UNAVAILABLE,
    published_at_interval: { value: posted.value, precision: posted.precision, start: posted.interval_start, end: posted.interval_end },
    first_seen_at: first, ingested_at: ingested
  };
}
function cleanRecord(raw) {
  if (!raw || typeof raw.nct_id !== 'string' || !/^NCT\d{8}$/.test(raw.nct_id)) fail('INVALID_SNAPSHOT_NCT_ID');
  if (!Array.isArray(raw.phases) || raw.phases.some(value => typeof value !== 'string')) fail('INVALID_SNAPSHOT_PHASES');
  if (!(raw.sponsor_name === null || typeof raw.sponsor_name === 'string') || !(raw.lead_sponsor_class === null || typeof raw.lead_sponsor_class === 'string') || !(raw.overall_status === null || typeof raw.overall_status === 'string')) fail('INVALID_SNAPSHOT_IDENTITY');
  if (raw.source_url !== 'https://clinicaltrials.gov/study/' + raw.nct_id || raw.source_api_url !== STUDIES_URL + '/' + raw.nct_id) fail('SNAPSHOT_SOURCE_URL_MISMATCH');
  const first = instant(raw.first_seen_at), ingested = instant(raw.ingested_at);
  if (ingested < first) fail('INGESTED_BEFORE_OBSERVATION');
  const interval = (key, basis) => {
    const original = raw[key];
    if (!original || typeof original !== 'object') fail('INVALID_SNAPSHOT_DATE_INTERVAL');
    let expected = dateInterval({ value: original.value, basis: original.basis }, { requireBasis: basis });
    if (original.value === null && original.reason === 'INVALID') expected = { ...expected, reason: 'INVALID' };
    if (original.reason === 'PRECISION_MISMATCH' && expected.availability === 'AVAILABLE') expected = { ...expected, availability: UNAVAILABLE, reason: 'PRECISION_MISMATCH', interval_start: null, interval_end: null };
    if (original.basis === null && original.basis_status === 'INVALID' && basis) expected = { ...expected, basis_status: 'INVALID' };
    if (stableJson(expected) !== stableJson(original)) fail('SNAPSHOT_DATE_INTERVAL_MISMATCH');
    return expected;
  };
  const primary = interval('primary_completion', true), start = interval('start_date', true), posted = interval('last_update_posted', false);
  if (raw.effective_at !== null || raw.published_at !== null || raw.comparison_method !== 'CURRENT_STATE_ONLY') fail('SNAPSHOT_CURRENT_STATE_MISMATCH');
  // Fixed allowlist: metric flags are discarded and recomputed. No contacts or other protocol fields are exported.
  return {
    nct_id: raw.nct_id, sponsor_name: raw.sponsor_name, lead_sponsor_class: raw.lead_sponsor_class, overall_status: raw.overall_status,
    phases: [...raw.phases], primary_completion: primary, start_date: start, last_update_posted: posted,
    source_url: raw.source_url, source_api_url: raw.source_api_url, comparison_method: 'CURRENT_STATE_ONLY',
    observation_channel: typeof raw.observation_channel === 'string' ? raw.observation_channel : UNAVAILABLE,
    effective_at: null, effective_at_status: 'UNAVAILABLE_NOT_AN_EVENT', published_at: null,
    published_at_status: posted.availability === 'AVAILABLE' ? 'DATE_INTERVAL_ONLY' : UNAVAILABLE,
    published_at_interval: { value: posted.value, precision: posted.precision, start: posted.interval_start, end: posted.interval_end },
    first_seen_at: first, ingested_at: ingested
  };
}
function dateCounts() { return { available_day: 0, available_month: 0, missing: 0, invalid: 0, unsupported_year: 0, precision_mismatch: 0, basis_missing: 0, basis_invalid: 0 }; }
function countDate(counts, interval) {
  const key = interval.availability === 'AVAILABLE' ? interval.precision === 'DAY' ? 'available_day' : 'available_month' : interval.reason === 'MISSING' ? 'missing' : interval.reason === 'UNSUPPORTED_YEAR' ? 'unsupported_year' : interval.reason === 'PRECISION_MISMATCH' ? 'precision_mismatch' : 'invalid';
  counts[key]++;
  if (interval.basis_status === 'MISSING') counts.basis_missing++;
  if (interval.basis_status === 'INVALID') counts.basis_invalid++;
}
const eligible = interval => interval.availability === 'AVAILABLE' && interval.basis_status === 'AVAILABLE' && interval.basis === 'ESTIMATED';
function metric(rows, denominator, dateField = 'primary_completion') {
  return { count: rows.length, day: rows.filter(row => row[dateField].precision === 'DAY').length, month: rows.filter(row => row[dateField].precision === 'MONTH').length, denominator, percentage: denominator ? rows.length / denominator * 100 : null, percentage_status: denominator ? 'MEASURED' : 'UNAVAILABLE_EMPTY_DENOMINATOR' };
}
function classify(recordsInput, { referenceDate, measuredAt, filters: filtersInput = {}, source = null } = {}) {
  if (!validDay(referenceDate)) fail('INVALID_REFERENCE_DATE');
  const measured = instant(measuredAt);
  if (referenceDate > measured.slice(0, 10)) fail('REFERENCE_AFTER_OBSERVATION');
  const filters = normalizeFilters(filtersInput);
  if (!Array.isArray(recordsInput)) fail('INVALID_SNAPSHOT_RECORDS');
  const cutoff = minusMonths(referenceDate, 12), ids = new Set(), records = [];
  const quality = { date_fields: { primary_completion: dateCounts(), start_date: dateCounts(), last_update_posted: dateCounts() }, sponsor_name_unavailable: 0, excluded_filter_mismatches: 0 };
  for (const raw of recordsInput) {
    const row = cleanRecord(raw);
    if (ids.has(row.nct_id)) fail('DUPLICATE_NCT_ID');
    ids.add(row.nct_id);
    if (row.first_seen_at > measured || row.ingested_at > measured) fail('RECORD_AFTER_MEASUREMENT');
    if (!inPopulation(row, filters)) { quality.excluded_filter_mismatches++; continue; }
    for (const field of Object.keys(quality.date_fields)) countDate(quality.date_fields[field], row[field]);
    if (row.sponsor_name === null) quality.sponsor_name_unavailable++;
    const a = eligible(row.primary_completion) && row.primary_completion.interval_end <= referenceDate;
    const b = a && row.last_update_posted.availability === 'AVAILABLE' && row.last_update_posted.interval_end <= cutoff;
    const c = a && row.primary_completion.interval_end <= cutoff;
    const d = row.overall_status === 'NOT_YET_RECRUITING' && eligible(row.start_date) && row.start_date.interval_end <= referenceDate;
    const days = a && row.primary_completion.precision === 'DAY' ? (Date.parse(referenceDate + 'T00:00:00Z') - Date.parse(row.primary_completion.value + 'T00:00:00Z')) / 86400000 : null;
    records.push({ ...row, metric_a: a, metric_b: b, metric_c: c, metric_d: d, days_after_estimated_date: days, reference_date: referenceDate });
  }
  records.sort((a, b) => a.nct_id.localeCompare(b.nct_id, 'en'));
  const aRows = records.filter(row => row.metric_a), bRows = aRows.filter(row => row.metric_b), cRows = aRows.filter(row => row.metric_c);
  const notYet = records.filter(row => row.overall_status === 'NOT_YET_RECRUITING'), dRows = notYet.filter(row => row.metric_d);
  const exact = aRows.filter(row => row.primary_completion.precision === 'DAY').map(row => row.days_after_estimated_date).sort((a, b) => a - b);
  const median = !exact.length ? null : exact.length % 2 ? exact[(exact.length - 1) / 2] : (exact[exact.length / 2 - 1] + exact[exact.length / 2]) / 2;
  return {
    schema_version: 1, policy_version: POLICY_VERSION, status: 'LOCAL_MEASUREMENT_NOT_PUBLICATION', measured_at: measured,
    reference_date: referenceDate, reference_scope: 'CURRENT_OBSERVED_SNAPSHOT_EVALUATED_AT_REFERENCE_DATE_NOT_HISTORICAL_AS_OF',
    filters, source, population: { records: records.length, returned_records: recordsInput.length, not_yet_recruiting: notYet.length },
    metrics: { A: metric(aRows, records.length), B: metric(bRows, aRows.length), C: metric(cRows, aRows.length), D: metric(dRows, notYet.length, 'start_date') },
    wall: { day_records: exact.length, month_records_excluded: aRows.filter(row => row.primary_completion.precision === 'MONTH').length, combined_elapsed_days: exact.reduce((sum, days) => sum + days, 0), combined_elapsed_years_divisor: 365.25, median_days: median, longest_days: exact.length ? exact[exact.length - 1] : null },
    quality, records, a_rows: aRows, notices: [...NOTICES]
  };
}
function csvCell(value) {
  let text = value === null || value === undefined ? UNAVAILABLE : Array.isArray(value) ? value.join('|') : String(value);
  if (/^[\u0000-\u0020]*[=+@\-\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function renderCsv(report) {
  if (!Array.isArray(report?.a_rows) || report.a_rows.length !== report.metrics?.A?.count) fail('INVALID_REPORT_FOR_CSV');
  const rows = report.a_rows.map(row => [row.nct_id, row.sponsor_name, row.overall_status, row.phases, row.primary_completion.value, row.primary_completion.basis, row.primary_completion.precision, row.primary_completion.interval_start, row.primary_completion.interval_end, row.last_update_posted.value, row.last_update_posted.precision, row.last_update_posted.interval_end, row.days_after_estimated_date, row.metric_b, row.metric_c, row.source_url, report.reference_date, row.first_seen_at, row.ingested_at]);
  return [CSV_COLUMNS, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
}
function parseCsv(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail('CSV_BOM_NOT_SUPPORTED');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { fail('INVALID_CSV_UTF8'); }
  if (text.startsWith('\ufeff')) fail('CSV_BOM_NOT_SUPPORTED');
  const rows = []; let row = [], cell = '', quoted = false, afterQuote = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') { if (text[index + 1] === '"') { cell += '"'; index++; } else { quoted = false; afterQuote = true; } }
      else cell += char;
    } else if (char === '"') { if (cell || afterQuote) fail('MALFORMED_CSV'); quoted = true; }
    else if (char === ',' || char === '\n') {
      row.push(cell); cell = ''; afterQuote = false;
      if (char === '\n') { rows.push(row); row = []; }
    } else if (char === '\r' && text[index + 1] === '\n') continue;
    else { if (afterQuote) fail('MALFORMED_CSV'); cell += char; }
  }
  if (quoted) fail('MALFORMED_CSV');
  if (cell || row.length || afterQuote) { row.push(cell); rows.push(row); }
  if (!rows.length || stableJson(rows[0]) !== stableJson(CSV_COLUMNS)) fail('CSV_COLUMNS_MISMATCH');
  const ids = new Set(), referenceDates = new Set();
  const objects = rows.slice(1).map(values => {
    if (values.length !== CSV_COLUMNS.length) fail('CSV_ROW_WIDTH_MISMATCH');
    const item = Object.fromEntries(CSV_COLUMNS.map((key, i) => [key, values[i]]));
    if (!/^NCT\d{8}$/.test(item.nct_id) || ids.has(item.nct_id)) fail('INVALID_CSV_NCT_ID');
    ids.add(item.nct_id); referenceDates.add(item.reference_date);
    if (!validDay(item.reference_date) || item.primary_completion_basis !== 'ESTIMATED') fail('INVALID_CSV_RECORD');
    const completion = dateInterval(item.primary_completion_date), posted = dateInterval(item.last_update_posted === UNAVAILABLE ? null : item.last_update_posted);
    if (completion.availability !== 'AVAILABLE' || completion.precision !== item.primary_completion_precision || completion.interval_start !== item.primary_completion_interval_start || completion.interval_end !== item.primary_completion_interval_end || completion.interval_end > item.reference_date) fail('CSV_DATE_INTERVAL_MISMATCH');
    if (posted.precision !== (item.last_update_posted_precision === UNAVAILABLE ? null : item.last_update_posted_precision) || (posted.interval_end ?? UNAVAILABLE) !== item.last_update_posted_interval_end) fail('CSV_DATE_INTERVAL_MISMATCH');
    const expectedDays = completion.precision === 'DAY' ? String((Date.parse(item.reference_date + 'T00:00:00Z') - Date.parse(completion.value + 'T00:00:00Z')) / 86400000) : UNAVAILABLE;
    if (item.days_after_estimated_date !== expectedDays || item.source_url !== 'https://clinicaltrials.gov/study/' + item.nct_id) fail('CSV_DERIVED_FIELD_MISMATCH');
    const cutoff = minusMonths(item.reference_date, 12);
    if (item.metric_b !== String(posted.availability === 'AVAILABLE' && posted.interval_end <= cutoff) || item.metric_c !== String(completion.interval_end <= cutoff)) fail('CSV_DERIVED_FIELD_MISMATCH');
    if (instant(item.ingested_at) < instant(item.first_seen_at)) fail('INGESTED_BEFORE_OBSERVATION');
    return item;
  });
  if (referenceDates.size > 1) fail('MIXED_CSV_REFERENCE_DATES');
  return { rows: objects, sha256: sha256(bytes), reference_date: [...referenceDates][0] ?? null };
}

function sourceVersion(body) {
  if (!body || typeof body.dataTimestamp !== 'string') fail('SOURCE_VERSION_UNAVAILABLE');
  const raw = body.dataTimestamp; let calendar;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/.test(raw)) {
    instant(raw + 'Z'); calendar = raw.slice(0, 10);
    return { data_timestamp: raw, api_version: typeof body.apiVersion === 'string' ? body.apiVersion : null, normalized_data_timestamp: null, reference_date: calendar, reference_date_timezone: UNAVAILABLE, reference_date_basis: 'SOURCE_CALENDAR_DATE_AS_WRITTEN' };
  }
  const normalized = instant(raw); calendar = normalized.slice(0, 10);
  return { data_timestamp: raw, api_version: typeof body.apiVersion === 'string' ? body.apiVersion : null, normalized_data_timestamp: normalized, reference_date: calendar, reference_date_timezone: 'UTC', reference_date_basis: 'UTC_SOURCE_TIMESTAMP' };
}
async function readOfficial(fetchImpl, url, { maxBytes = 16 * 1024 * 1024, timeoutMs = 45000 } = {}) {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://clinicaltrials.gov' || !['/api/v2/version', '/api/v2/studies'].includes(parsed.pathname) || parsed.username || parsed.password) fail('NON_OFFICIAL_SOURCE_URL');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json', 'User-Agent': 'ORION Stale Clock / hello@orionbiotechai.com' }, signal: controller.signal });
    if (!response?.ok) fail('SOURCE_HTTP_UNAVAILABLE');
    if (response.redirected || response.url && new URL(response.url).origin !== parsed.origin) fail('SOURCE_REDIRECT_REFUSED');
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) fail('SOURCE_CONTENT_TYPE_UNAVAILABLE');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) fail('SOURCE_RESPONSE_TOO_LARGE');
    if (!response.body || typeof response.body.getReader !== 'function') fail('SOURCE_BODY_STREAM_UNAVAILABLE');
    const reader = response.body.getReader(), parts = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) { await reader.cancel(); fail('SOURCE_RESPONSE_TOO_LARGE'); }
        parts.push(Buffer.from(next.value));
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(parts); let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (_) { fail('SOURCE_JSON_INVALID'); }
    return { body, bytes: size, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof ClockError) throw error;
    fail(controller.signal.aborted ? 'SOURCE_REQUEST_TIMEOUT' : 'SOURCE_REQUEST_UNAVAILABLE');
  } finally { clearTimeout(timer); }
}
async function collect({ filters: filtersInput = {}, referenceDate = null, pageSize = 100, maxPages = 100, maxRecords = 20000, fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), minRequestIntervalMs = 1000, waitImpl = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  const filters = normalizeFilters(filtersInput);
  studiesQuery(filters, { pageSize });
  if (typeof fetchImpl !== 'function' || typeof clock !== 'function' || typeof waitImpl !== 'function' || !Number.isSafeInteger(minRequestIntervalMs) || minRequestIntervalMs < 0 || minRequestIntervalMs > 60000 || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000 || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100000) fail('INVALID_COLLECTION_LIMITS');
  let madeRequest = false;
  const read = async (url, limits) => {
    // Conservative project policy, not an assertion of the provider's quota.
    // One request at a time, one second after the prior request finishes; no retries.
    if (madeRequest && minRequestIntervalMs > 0) await waitImpl(minRequestIntervalMs);
    madeRequest = true;
    return readOfficial(fetchImpl, url, limits);
  };
  const began = instant(clock()), beforeResponse = await read(VERSION_URL, { maxBytes: 16384 }), before = sourceVersion(beforeResponse.body);
  const chosenReference = referenceDate ?? previousMonthEnd(before.reference_date);
  if (!validDay(chosenReference) || chosenReference > before.reference_date) fail('INVALID_REFERENCE_DATE');
  let token = null, total = null, complete = false, bytes = beforeResponse.bytes;
  const ids = new Set(), tokens = new Set(), records = [], pages = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await read(studiesQuery(filters, { pageSize, pageToken: token }));
    bytes += result.bytes; if (bytes > 256 * 1024 * 1024) fail('SOURCE_TOTAL_BYTE_LIMIT_EXCEEDED');
    const observed = instant(clock()), body = result.body;
    if (!body || !Array.isArray(body.studies) || body.studies.length > pageSize) fail('MALFORMED_SOURCE_PAGE');
    if (page === 1 && !Number.isSafeInteger(body.totalCount)) fail('SOURCE_TOTAL_UNAVAILABLE');
    if (body.totalCount !== undefined) {
      if (!Number.isSafeInteger(body.totalCount) || body.totalCount < 0 || body.totalCount > maxRecords) fail('SOURCE_TOTAL_OUT_OF_RANGE');
      if (total !== null && body.totalCount !== total) fail('SOURCE_TOTAL_CHANGED');
      total = body.totalCount;
    }
    const projected = body.studies.map(study => projectStudy(study, { observedAt: observed }));
    for (const record of projected) {
      if (ids.has(record.nct_id)) fail('DUPLICATE_NCT_ID');
      if (!inPopulation(record, filters)) fail('SOURCE_FILTER_MISMATCH');
      ids.add(record.nct_id); records.push(record);
      if (records.length > maxRecords) fail('SOURCE_RECORD_LIMIT_EXCEEDED');
    }
    pages.push({ page, checked_at: observed, records: projected.length, source_response_sha256: result.sha256 });
    const next = body.nextPageToken;
    if (next === undefined || next === null) { complete = true; break; }
    if (!projected.length) fail('EMPTY_PAGE_WITH_SUCCESSOR');
    studiesQuery(filters, { pageSize, pageToken: next });
    if (tokens.has(next)) fail('REPEATED_PAGE_TOKEN');
    tokens.add(next); token = next;
  }
  if (!complete) fail('PAGINATION_LIMIT_REACHED');
  if (records.length !== total) fail('SOURCE_TOTAL_MISMATCH');
  const afterResponse = await read(VERSION_URL, { maxBytes: 16384 }), after = sourceVersion(afterResponse.body);
  bytes += afterResponse.bytes; if (bytes > 256 * 1024 * 1024) fail('SOURCE_TOTAL_BYTE_LIMIT_EXCEEDED');
  if (before.data_timestamp !== after.data_timestamp || before.api_version !== after.api_version) fail('SOURCE_VERSION_CHANGED');
  const ended = instant(clock());
  if (ended < began || pages.some(page => page.checked_at < began || page.checked_at > ended)) fail('OBSERVATION_CLOCK_INCONSISTENT');
  const source = { provider: 'ClinicalTrials.gov API v2', query_url: studiesQuery(filters, { pageSize }), version_url: VERSION_URL, version_before: before, version_after: after, source_checked_at_start: began, source_checked_at_end: ended, pages, page_count: pages.length, response_bytes: bytes, pagination_complete: true, source_version_stable: true, advertised_total: total, request_spacing_ms: minRequestIntervalMs, request_spacing_policy: 'PROJECT_POLICY_NOT_PROVIDER_QUOTA' };
  return classify(records.map(row => ({ ...row, ingested_at: ended })), { referenceDate: chosenReference, measuredAt: ended, filters, source });
}
function writeOutput(report, directory) {
  if (typeof directory !== 'string' || !directory.trim()) fail('OUTPUT_DIRECTORY_REQUIRED');
  const root = path.resolve(directory);
  if (fs.existsSync(root)) fail('OUTPUT_DIRECTORY_EXISTS');
  const csv = renderCsv(report), summary = { ...report }; delete summary.records; delete summary.a_rows;
  const snapshot = { schema_version: 1, reference_date: report.reference_date, measured_at: report.measured_at, filters: report.filters, source: report.source, records: report.records.map(cleanRecord) };
  const files = { 'snapshot.json': JSON.stringify(snapshot, null, 2) + '\n', 'report-summary.json': JSON.stringify(summary, null, 2) + '\n', 'data.csv': csv };
  fs.mkdirSync(path.dirname(root), { recursive: true }); fs.mkdirSync(root);
  const manifest = { schema_version: 1, status: 'LOCAL_MEASUREMENT_NOT_PUBLICATION', measured_at: report.measured_at, reference_date: report.reference_date, hash_scope: 'Byte integrity only; no external time proof or fact verification.', files: {} };
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), value, { flag: 'wx', mode: 0o600 });
    manifest.files[name] = { sha256: sha256(value), bytes: Buffer.byteLength(value) };
  }
  // Written last; failures leave partial local output explicitly incomplete.
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { files: Object.keys(files), csv_sha256: manifest.files['data.csv'].sha256, status: manifest.status };
}

module.exports = { ClockError, sha256, stableJson, validDay, instant, dateInterval, previousMonthEnd, minusMonths, normalizeFilters, studiesQuery, projectStudy, cleanRecord, classify, renderCsv, parseCsv, collect, readOfficial, writeOutput, POLICY_VERSION, ACTIVE_STATUSES, CSV_COLUMNS, STUDIES_URL, VERSION_URL, UNAVAILABLE };

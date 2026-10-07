'use strict';

// Offline presentation of the exact reviewed snapshot. This module has no I/O.
const core = require('./stale-clock');
const CSV_SHA256 = 'be429676b07fa0bd6077311c8368110b79bf43aadc9806c8d58fbf84a821cff5';
const SNAPSHOT_SHA256 = 'f4cc0e6c8634813841cfae23cfed41dcf2d1e3abda302c8f6396c8047e8e7096';
const REFERENCE_DATE = '2026-08-31';
const EXPECTED_BUCKETS = Object.freeze([148, 61, 90, 60, 18]);
const BUCKET_LABELS = Object.freeze(['[0, 3]', '(3, 6]', '(6, 12]', '(12, 24]', '>24']);
const fail = code => { throw new core.ClockError(code); };
const equal = (a, b) => core.stableJson(a) === core.stableJson(b);
const format = number => number.toLocaleString('en-US');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function calendarMonthCutoffs(referenceDate = REFERENCE_DATE) {
  if (!core.validDay(referenceDate)) fail('INVALID_REFERENCE_DATE');
  return [3, 6, 12, 24].map(months => core.minusMonths(referenceDate, months));
}
function bucketIndex(endpointDate, referenceDate = REFERENCE_DATE) {
  if (!core.validDay(endpointDate) || !core.validDay(referenceDate)) fail('INVALID_BUCKET_DATE');
  if (endpointDate > referenceDate) fail('ENDPOINT_AFTER_REFERENCE');
  const index = calendarMonthCutoffs(referenceDate).findIndex(boundary => endpointDate >= boundary);
  return index === -1 ? 4 : index;
}
function elapsedStatistics(values) {
  if (!values.length || values.some(value => !Number.isSafeInteger(value) || value < 0)) fail('INVALID_ELAPSED_VALUES');
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return {
    records: values.length,
    medianDays: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    longestDays: sorted.at(-1),
    zeroDays: values.filter(value => value === 0).length
  };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function computeSummary({ csvBytes, snapshotBytes } = {}) {
  if (!Buffer.isBuffer(csvBytes) || !Buffer.isBuffer(snapshotBytes)) fail('FROZEN_INPUT_BUFFERS_REQUIRED');
  if (core.sha256(csvBytes) !== CSV_SHA256) fail('FROZEN_CSV_SHA256_MISMATCH');
  if (core.sha256(snapshotBytes) !== SNAPSHOT_SHA256) fail('FROZEN_SNAPSHOT_SHA256_MISMATCH');
  const csv = core.parseCsv(csvBytes), snapshot = JSON.parse(snapshotBytes.toString('utf8'));
  if (snapshot.reference_date !== REFERENCE_DATE || snapshot.source?.pagination_complete !== true ||
      snapshot.source?.source_version_stable !== true) fail('FROZEN_POPULATION_PROVENANCE_REQUIRED');
  // Recompute from the full projection; stored flags and the selected CSV alone
  // are not proof of the denominator or of complementary record dates.
  const report = core.classify(snapshot.records, {
    referenceDate: REFERENCE_DATE, measuredAt: snapshot.measured_at, source: snapshot.source
  });
  if (!Buffer.from(core.renderCsv(report), 'utf8').equals(csvBytes)) fail('CSV_FULL_POPULATION_IDENTITY_MISMATCH');
  if (csv.rows.length !== 377 || report.population.records !== 3762 || report.metrics.A.count !== 377 ||
      report.metrics.A.day !== 224 || report.metrics.A.month !== 153) fail('FROZEN_POPULATION_GATE_FAILED');

  const boundaries = calendarMonthCutoffs();
  const buckets = BUCKET_LABELS.map((label, index) => ({
    label, count: 0, day: 0, month: 0,
    endpointFrom: index === 4 ? null : boundaries[index],
    endpointTo: index === 0 ? REFERENCE_DATE : boundaries[index - 1],
    fromInclusive: index !== 4, toInclusive: index === 0
  }));
  const elapsed = [], exact = [], months = [];
  for (const row of csv.rows) {
    const date = core.dateInterval(row.primary_completion_date);
    if (date.availability !== 'AVAILABLE' || date.interval_end !== row.primary_completion_interval_end) fail('CSV_ENDPOINT_MISMATCH');
    const bucket = buckets[bucketIndex(date.interval_end)];
    bucket.count++;
    bucket[date.precision === 'DAY' ? 'day' : 'month']++;
    const days = (Date.parse(REFERENCE_DATE + 'T00:00:00Z') - Date.parse(date.interval_end + 'T00:00:00Z')) / 86400000;
    elapsed.push(days);
    (date.precision === 'DAY' ? exact : months).push(days);
    if (date.precision === 'MONTH' && row.days_after_estimated_date !== 'UNAVAILABLE') fail('ORIGINAL_MONTH_ELAPSED_MUST_REMAIN_UNAVAILABLE');
  }
  const complementary = { estimatedAfterReference: 0, actualOnOrBeforeReference: 0, actualAfterReference: 0, unavailable: 0 };
  for (const row of report.records.filter(row => !row.metric_a)) {
    const date = row.primary_completion;
    if (date.availability !== 'AVAILABLE' || date.basis_status !== 'AVAILABLE') complementary.unavailable++;
    else if (date.basis === 'ESTIMATED' && date.interval_end > REFERENCE_DATE) complementary.estimatedAfterReference++;
    else if (date.basis === 'ACTUAL') complementary[date.interval_end <= REFERENCE_DATE ? 'actualOnOrBeforeReference' : 'actualAfterReference']++;
    else fail('UNEXPECTED_COMPLEMENT_CLASSIFICATION');
  }
  const allEndpoints = elapsedStatistics(elapsed), exactDays = elapsedStatistics(exact), monthEndpoints = elapsedStatistics(months);
  if (!equal(buckets.map(bucket => bucket.count), EXPECTED_BUCKETS) ||
      buckets.reduce((sum, bucket) => sum + bucket.count, 0) !== 377 ||
      allEndpoints.medianDays !== 153 || allEndpoints.longestDays !== 2650 ||
      exactDays.medianDays !== 153 || exactDays.longestDays !== 2650 ||
      !equal(complementary, { estimatedAfterReference: 2842, actualOnOrBeforeReference: 540, actualAfterReference: 3, unavailable: 0 })) fail('FROZEN_CHART_GATE_FAILED');
  const total = report.population.records, selected = csv.rows.length, other = total - selected;
  if (selected + other !== 3762 || other !== 3385) fail('FROZEN_COMPLEMENT_GATE_FAILED');
  return freeze({
    schemaVersion: 'orion-stale-clock-summary-charts-v1',
    status: 'DRAFT_CLAUDE_REVIEW_REQUIRED',
    copyStatus: 'OTHER_RECORDS_PROPOSAL_ONLY_NOT_RELEASE_APPROVAL',
    referenceDate: REFERENCE_DATE, observedAt: snapshot.measured_at,
    sources: {
      csv: { file: 'data/2026-09-29/data.csv', sha256: CSV_SHA256, bytes: csvBytes.length, rows: selected, scope: 'Selected A records only' },
      snapshot: { file: 'data/2026-09-29/snapshot.json', sha256: SNAPSHOT_SHA256, bytes: snapshotBytes.length, records: total, scope: 'Full frozen reference population' }
    },
    population: { total, selected, other, selectedPercentage: selected / total * 100, otherPercentage: other / total * 100, complementary },
    proportion: [
      { key: 'selected', label: 'Estimated date on or before reference', count: selected, percentage: selected / total * 100 },
      { key: 'other', label: 'Other records', count: other, percentage: other / total * 100 }
    ],
    boundaries, buckets,
    elapsed: { allEndpoints, exactDays, monthEndpoints },
    rules: {
      selection: 'ESTIMATED primary completion interval ending on or before 2026-08-31; equality is included.',
      denominator: '3,762 comes from the full frozen snapshot, not the 377-row CSV.',
      complement: 'Other records means records not meeting A. It includes ACTUAL dates on or before the reference; it does not mean future dates.',
      buckets: 'Calendar subtraction clamps month ends. Exact 3/6/12/24-month boundaries enter the younger inclusive bucket. Bins have unequal widths; bar heights are counts, not density.',
      endpoints: 'DAY dates use their exact day. MONTH dates use their interval end only for this derived chart; no exact source day is asserted.',
      elapsed: 'All 377 interval endpoints give median 153 days and longest 2,650 days. The original Wall uses only 224 DAY records and independently has the same values; its bytes and method are unchanged.',
      sourceTime: 'Observed 29 September 2026; reference 31 August 2026. This is not a historical as-of reconstruction.'
    },
    notices: ['Registered completion dates are not promises of results announcements.', 'Hashes establish byte identity, not source truth or an external timestamp.', 'The proposed complementary label and new charts require Claude review before release.']
  });
}
function requireSummary(summary) {
  if (summary?.schemaVersion !== 'orion-stale-clock-summary-charts-v1' ||
      summary.sources?.csv?.sha256 !== CSV_SHA256 || summary.sources?.snapshot?.sha256 !== SNAPSHOT_SHA256 ||
      summary.population?.selected !== 377 || summary.population?.other !== 3385 || summary.population?.total !== 3762 ||
      !equal(summary.buckets?.map(bucket => bucket.count), EXPECTED_BUCKETS)) fail('VALIDATED_FROZEN_SUMMARY_REQUIRED');
}
function svgStart(kind, width, height, title, description) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height +
    '" role="img" aria-labelledby="summary-' + kind + '-title summary-' + kind + '-desc" style="max-width:100%;height:auto">' +
    '<title id="summary-' + kind + '-title">' + escape(title) + '</title><desc id="summary-' + kind + '-desc">' + escape(description) +
    '</desc><rect width="' + width + '" height="' + height + '" fill="#f5f7f6"/><g font-family="Arial, Helvetica, sans-serif" fill="#172c3a">';
}
const text = (x, y, size, value, extra = '') => '<text x="' + x + '" y="' + y + '" font-size="' + size + '" ' + extra + '>' + escape(value) + '</text>';
const rect = (x, y, width, height, fill) => '<rect x="' + x + '" y="' + y + '" width="' + width + '" height="' + height + '" fill="' + fill + '"/>';
const line = (x1, y1, x2, y2, stroke) => '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + stroke + '"/>';
function proportionSvg(summary) {
  requireSummary(summary);
  const { selected, other, total, selectedPercentage } = summary.population, percent = selectedPercentage.toFixed(0), width = 720 * selected / total;
  return svgStart('proportion', 800, 355, 'Selected estimated dates: ' + selected + ' of ' + format(total),
    selected + ' (' + percent + '%) estimated primary completion intervals ended on or before 31 August 2026. Other records: ' + format(other) + ' (90%), including actual dates. Denominator from the full frozen snapshot, not the selected CSV. Counts start at zero.') +
    text(32, 56, 38, selected + ' of ' + format(total) + ' (' + percent + '%)', 'font-weight="700"') +
    text(32, 91, 21, 'Estimated primary completion on or before 31 Aug 2026') +
    text(32, 120, 17, 'Observed 29 Sep 2026 · frozen reference population') +
    rect(40, 156, width, 56, '#28495f') + rect(40 + width, 156, 720 - width, 56, '#d4dcdf') +
    text(40 + width / 2, 192, 26, selected, 'text-anchor="middle" fill="#ffffff" font-weight="700"') +
    text(40 + width + (720 - width) / 2, 192, 26, format(other), 'text-anchor="middle" font-weight="700"') +
    line(40, 224, 760, 224, '#566b78') + text(40, 249, 24, '0') + text(760, 249, 24, format(total) + ' records', 'text-anchor="end"') +
    rect(40, 267, 16, 16, '#28495f') + text(68, 284, 26, selected + ' (' + percent + '%) selected') +
    rect(390, 267, 16, 16, '#d4dcdf') + text(418, 284, 26, format(other) + ' (90%) other records') +
    text(40, 322, 16, 'Other records are outside the selection, including ACTUAL dates.') + '</g></svg>\n';
}
function distributionSvg(summary) {
  requireSummary(summary);
  const top = 126, bottom = 326, yMax = 160, scale = (bottom - top) / yMax;
  let svg = svgStart('distribution', 800, 460, 'Elapsed calendar-month distribution of 377 selected records',
    summary.buckets.map(b => b.label + ' months: ' + b.count + ' records (' + b.day + ' DAY and ' + b.month + ' MONTH)').join('; ') +
    '. Unequal calendar-month bins; bars are counts, not density. MONTH dates use month end. Median 153 days; longest 2,650 days over all 377 interval endpoints.') +
    text(32, 46, 29, 'Elapsed time at 31 Aug 2026', 'font-weight="700"') +
    text(32, 76, 18, '377 interval endpoints · month-only dates use month end') +
    text(32, 104, 16, 'Records');
  for (const n of [0, 40, 80, 120, 160]) {
    const y = bottom - n * scale;
    svg += line(68, y, 770, y, n === 0 ? '#566b78' : '#d7dfe2') + text(55, y + 7, 24, n, 'text-anchor="end"');
  }
  summary.buckets.forEach((bucket, index) => {
    const center = 132 + index * 139, height = bucket.count * scale;
    svg += rect(center - 39, bottom - height, 78, height, '#28495f') +
      text(center, bottom - height - 10, 28, bucket.count, 'text-anchor="middle" font-weight="700"') +
      text(center, 358, 26, bucket.label, 'text-anchor="middle"');
  });
  return svg + text(400, 384, 17, 'Calendar months · unequal bin widths; counts, not density', 'text-anchor="middle"') +
    text(32, 416, 17, 'All 377 endpoints: median 153 days; longest 2,650 days.') +
    text(32, 442, 15, 'The original Wall DAY-only statistics remain a separate calculation.') + '</g></svg>\n';
}
function socialSvg(summary) {
  requireSummary(summary);
  const { selected, other, total } = summary.population, width = 1080 * selected / total;
  return svgStart('social', 1200, 630, '377 of 3,762 records (10%)',
    'Observed 29 September 2026. 377 estimated primary completion intervals end on or before 31 August 2026; 3,385 other records include ACTUAL dates. Full population from the frozen snapshot; selected records from the hash-verified CSV.') +
    text(60, 65, 24, 'ORION BIOTECH · STALE CLOCK', 'letter-spacing="2"') +
    text(60, 163, 72, selected + ' of ' + format(total) + ' (10%)', 'font-weight="700"') +
    text(60, 222, 31, 'Estimated primary completion dates') +
    text(60, 266, 31, 'on or before 31 August 2026') +
    rect(60, 314, width, 80, '#28495f') + rect(60 + width, 314, 1080 - width, 80, '#d4dcdf') +
    text(60 + width / 2, 364, 27, selected, 'text-anchor="middle" fill="#ffffff" font-weight="700"') +
    text(60 + width + (1080 - width) / 2, 364, 30, format(other), 'text-anchor="middle" font-weight="700"') +
    line(60, 406, 1140, 406, '#566b78') + text(60, 438, 22, '0') + text(1140, 438, 22, format(total) + ' records', 'text-anchor="end"') +
    text(60, 486, 25, selected + ' selected · ' + format(other) + ' other records') +
    text(60, 525, 22, 'Other records include ACTUAL dates; they are not all future dates.') +
    text(60, 575, 20, 'Observed 29 Sep 2026 · ClinicalTrials.gov frozen snapshot') +
    text(60, 606, 17, 'Registered dates, not results-announcement promises · CSV SHA-256 be429676…cff5') + '</g></svg>\n';
}
function renderHtml(summary) {
  requireSummary(summary);
  const rows = summary.buckets.map(b => '<tr><th scope="row">' + escape(b.label) + '</th><td>' + b.day + '</td><td>' + b.month + '</td><td>' + b.count + '</td></tr>').join('');
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Stale Clock summary chart review</title>' +
    '<style>body{margin:0;background:#f5f7f6;color:#172c3a;font:16px/1.5 Arial,sans-serif}main{max-width:800px;margin:auto;padding:20px}svg{display:block;width:100%;height:auto}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{text-align:left;padding:9px;border-bottom:1px solid #cbd5db}code{overflow-wrap:anywhere}h1{font-size:26px}a{color:#28495f}</style><main>' +
    '<h1>Stale Clock summary charts</h1><p>Private Draft: the proposed “Other records” wording and new presentation require Claude review. This file is not a publication receipt.</p>' +
    '<figure style="margin:0">' + proportionSvg(summary) + '<figcaption>' + escape(summary.rules.denominator) + ' ' + escape(summary.rules.complement) + '</figcaption></figure>' +
    '<table><caption>Frozen reference population</caption><thead><tr><th scope="col">Group</th><th scope="col">Records</th><th scope="col">Rounded share</th></tr></thead><tbody><tr><th scope="row">Estimated date on or before reference</th><td>377</td><td>10%</td></tr><tr><th scope="row">Other records</th><td>3,385</td><td>90%</td></tr><tr><th scope="row">Total</th><td>3,762</td><td>100%</td></tr></tbody></table>' +
    '<figure style="margin:0">' + distributionSvg(summary) + '<figcaption>' + escape(summary.rules.buckets) + ' ' + escape(summary.rules.endpoints) + '</figcaption></figure>' +
    '<table><caption>Calendar-month distribution; interval endpoints at 31 August 2026</caption><thead><tr><th scope="col">Months</th><th scope="col">DAY</th><th scope="col">MONTH</th><th scope="col">Records</th></tr></thead><tbody>' + rows + '<tr><th scope="row">Total</th><td>224</td><td>153</td><td>377</td></tr></tbody></table>' +
    '<p>' + escape(summary.rules.elapsed) + '</p><p>' + escape(summary.rules.sourceTime) + '</p><p><a href="https://www.orionbiotechai.com/reports/stale-clock/2026-09-29/wall">Explore every record on the wall →</a></p>' +
    '<p>CSV SHA-256 <code>' + CSV_SHA256 + '</code><br>Full population SHA-256 <code>' + SNAPSHOT_SHA256 + '</code></p><p>' + escape(summary.notices[0]) + '</p></main></html>\n';
}
module.exports = { CSV_SHA256, SNAPSHOT_SHA256, REFERENCE_DATE, EXPECTED_BUCKETS, calendarMonthCutoffs, bucketIndex, computeSummary, proportionSvg, distributionSvg, socialSvg, renderHtml };

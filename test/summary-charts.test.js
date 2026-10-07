'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const core = require('../src/stale-clock');
const charts = require('../src/summary-charts');
const cli = require('../bin/reproduce-summary-charts');
const ROOT = path.resolve(__dirname, '..');
const csvBytes = fs.readFileSync(path.join(ROOT, 'data/2026-09-29/data.csv'));
const snapshotBytes = fs.readFileSync(path.join(ROOT, 'data/2026-09-29/snapshot.json'));
const summary = () => charts.computeSummary({csvBytes, snapshotBytes});

test('frozen population reproduces selected identities, complement and precision-separated counts', () => {
  const result = summary();
  assert.deepEqual(result.buckets.map(b => [b.count, b.day, b.month]), [[148,88,60],[61,38,23],[90,52,38],[60,37,23],[18,9,9]]);
  assert.equal(result.population.total, 3762);
  assert.equal(result.population.selected, 377);
  assert.equal(result.population.other, 3385);
  assert.deepEqual(result.population.complementary, {estimatedAfterReference:2842, actualOnOrBeforeReference:540, actualAfterReference:3, unavailable:0});
  assert.equal(result.elapsed.allEndpoints.medianDays, 153);
  assert.equal(result.elapsed.allEndpoints.longestDays, 2650);
  assert.equal(result.elapsed.allEndpoints.zeroDays, 31);
  assert.equal(result.elapsed.exactDays.records, 224);
  assert.equal(result.elapsed.exactDays.zeroDays, 11);
  assert.equal(result.elapsed.monthEndpoints.records, 153);
  assert.equal(result.elapsed.monthEndpoints.medianDays, 184);
  assert.equal(result.copyStatus, 'OTHER_RECORDS_PROPOSAL_ONLY_NOT_RELEASE_APPROVAL');
  assert.throws(() => {result.buckets[0].count = 1;}, TypeError);
});

test('every 3/6/12/24-month boundary is exhaustive with equality in the younger bucket', () => {
  assert.deepEqual(charts.calendarMonthCutoffs(), ['2026-05-31','2026-02-28','2025-08-31','2024-08-31']);
  for (const [day,index] of [
    ['2026-08-31',0],['2026-05-31',0],['2026-05-30',1],
    ['2026-02-28',1],['2026-02-27',2],['2025-08-31',2],
    ['2025-08-30',3],['2024-08-31',3],['2024-08-30',4]
  ]) assert.equal(charts.bucketIndex(day), index, day);
  assert.throws(() => charts.bucketIndex('2026-09-01'), /ENDPOINT_AFTER_REFERENCE/);
  assert.throws(() => charts.bucketIndex('2026-02-29'), /INVALID_BUCKET_DATE/);
  assert.throws(() => charts.bucketIndex('2026-02'), /INVALID_BUCKET_DATE/);
  assert.deepEqual(charts.calendarMonthCutoffs('2024-08-31'), ['2024-05-31','2024-02-29','2023-08-31','2022-08-31']);
});

test('month-end chart derivation never changes MONTH source precision or elapsed-day CSV cells', () => {
  const before = Buffer.from(csvBytes);
  summary();
  const parsed = core.parseCsv(csvBytes).rows, monthRows = parsed.filter(r => r.primary_completion_precision === 'MONTH');
  assert.equal(monthRows.length, 153);
  assert.ok(monthRows.every(r => r.days_after_estimated_date === 'UNAVAILABLE' && /^\d{4}-\d{2}$/.test(r.primary_completion_date)));
  assert.equal(charts.bucketIndex(core.dateInterval('2026-05').interval_end), 0);
  assert.equal(charts.bucketIndex(core.dateInterval('2026-02').interval_end), 1);
  assert.equal(charts.bucketIndex(core.dateInterval('2025-08').interval_end), 2);
  assert.equal(charts.bucketIndex(core.dateInterval('2024-08').interval_end), 3);
  assert.deepEqual(csvBytes, before);
});

test('byte provenance fails closed for altered CSV, substitute snapshot or missing denominator', () => {
  assert.throws(() => charts.computeSummary({csvBytes:Buffer.concat([csvBytes,Buffer.from(' ')]),snapshotBytes}), /FROZEN_CSV_SHA256_MISMATCH/);
  const altered = Buffer.from(snapshotBytes); altered[altered.length - 1] ^= 1;
  assert.throws(() => charts.computeSummary({csvBytes,snapshotBytes:altered}), /FROZEN_SNAPSHOT_SHA256_MISMATCH/);
  assert.throws(() => charts.computeSummary({csvBytes}), /FROZEN_INPUT_BUFFERS_REQUIRED/);
  assert.equal(core.sha256(csvBytes), charts.CSV_SHA256);
  assert.equal(core.sha256(snapshotBytes), charts.SNAPSHOT_SHA256);
});

test('accessible computed charts use zero axes and retain the factual complement limit', () => {
  const result = summary();
  for (const render of [charts.proportionSvg,charts.distributionSvg,charts.socialSvg]) {
    const svg = render(result);
    assert.match(svg, /role="img" aria-labelledby=/);
    assert.match(svg, /<title id=/); assert.match(svg, /<desc id=/);
    assert.match(svg, />0<\/text>/);
    assert.doesNotMatch(svg, /Not passed|148\.8|<script|onload=|href="https?:/i);
    assert.equal(svg, render(result));
  }
  const distribution = charts.distributionSvg(result);
  for (const bucket of result.buckets) assert.ok(distribution.includes('>' + bucket.count + '</text>'));
  assert.match(distribution, /counts, not density/);
  assert.match(charts.socialSvg(result), /width="1200" height="630" viewBox="0 0 1200 630"/);
  assert.match(charts.proportionSvg(result), /including ACTUAL dates/);
  const html = charts.renderHtml(result);
  assert.equal((html.match(/<table>/g) || []).length, 2);
  assert.match(html, /scope="col"/); assert.match(html, /scope="row"/);
  assert.match(html, /median 153 days and longest 2,650 days/);
  assert.throws(() => charts.socialSvg({...result,population:{...result.population,total:4000}}), /VALIDATED_FROZEN_SUMMARY_REQUIRED/);
});

function tempRoot(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-summary-chart-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(directory), relative = path.relative(fs.realpathSync(os.tmpdir()), resolved);
    assert.ok(relative.startsWith('orion-summary-chart-test-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    fs.rmSync(directory, {recursive:true});
  });
  return directory;
}
test('explicit CLI output is local, hash-bound, append-only and refuses existing files/directories', t => {
  const root = tempRoot(t), out = path.join(root, 'new');
  assert.throws(() => cli.parseArguments([]), /EXPLICIT_NEW_OUTPUT_DIRECTORY_REQUIRED/);
  assert.throws(() => cli.parseArguments(['--out',out,'--force']), /EXPLICIT_NEW_OUTPUT_DIRECTORY_REQUIRED/);
  const run = spawnSync(process.execPath, [path.join(ROOT,'bin/reproduce-summary-charts.js'),'--out',out], {encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).requests, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
  assert.equal(Object.keys(manifest.files).length, 5);
  for (const [name,ref] of Object.entries(manifest.files)) {
    const bytes = fs.readFileSync(path.join(out,name));
    assert.equal(core.sha256(bytes), ref.sha256); assert.equal(bytes.length, ref.bytes);
  }
  const previous = fs.readFileSync(path.join(out,'summary.json'));
  assert.throws(() => cli.main(['--out',out]), /OUTPUT_DIRECTORY_EXISTS/);
  assert.deepEqual(fs.readFileSync(path.join(out,'summary.json')), previous);
  const occupied = path.join(root,'existing.txt'); fs.writeFileSync(occupied,'sentinel');
  assert.throws(() => cli.main(['--out',occupied]), /OUTPUT_DIRECTORY_EXISTS/);
  assert.equal(fs.readFileSync(occupied,'utf8'),'sentinel');
});

test('CLI rejects an existing junction parent rather than following it', t => {
  const root = tempRoot(t), target = path.join(root,'target'), link = path.join(root,'link');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, 'junction');
  assert.throws(() => cli.main(['--out',path.join(link,'new')]), /OUTPUT_SYMLINK_OR_JUNCTION_REJECTED/);
  assert.deepEqual(fs.readdirSync(target), []);
});

#!/usr/bin/env node
'use strict';

// Local frozen inputs only. No account, HTTP client, environment credentials,
// reference-date override or existing-directory overwrite is available.
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/stale-clock');
const charts = require('../src/summary-charts');
const ROOT = path.resolve(__dirname, '..');
const HELP = 'Offline frozen Stale Clock summary charts\n\nnode bin/reproduce-summary-charts.js --out NEW_DIRECTORY\n\nCreates summary.json, three SVGs, review.html and a byte-hash manifest.\nThe output directory must not exist. No network requests are made.\n';

function parseArguments(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  if (argv.length !== 2 || argv[0] !== '--out' || !argv[1] || argv[1].startsWith('--')) throw new core.ClockError('EXPLICIT_NEW_OUTPUT_DIRECTORY_REQUIRED');
  return { output: path.resolve(argv[1]) };
}
function checkOutput(directory) {
  for (let current = directory;; current = path.dirname(current)) {
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      if (stat.isSymbolicLink()) throw new core.ClockError('OUTPUT_SYMLINK_OR_JUNCTION_REJECTED');
      if (current === directory) throw new core.ClockError('OUTPUT_DIRECTORY_EXISTS');
      if (!stat.isDirectory()) throw new core.ClockError('OUTPUT_PARENT_NOT_DIRECTORY');
    }
    if (path.dirname(current) === current) break;
  }
}
function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) return { help: HELP };
  checkOutput(options.output);
  const csvPath = path.join(ROOT, 'data/2026-09-29/data.csv');
  const snapshotPath = path.join(ROOT, 'data/2026-09-29/snapshot.json');
  const csvBytes = fs.readFileSync(csvPath), snapshotBytes = fs.readFileSync(snapshotPath);
  const summary = charts.computeSummary({ csvBytes, snapshotBytes });
  const files = {
    'summary.json': JSON.stringify(summary, null, 2) + '\n',
    'proportion.svg': charts.proportionSvg(summary),
    'distribution.svg': charts.distributionSvg(summary),
    'summary-social.svg': charts.socialSvg(summary),
    'review.html': charts.renderHtml(summary)
  };
  // Recheck source bytes immediately before creating any output.
  if (!fs.readFileSync(csvPath).equals(csvBytes) || !fs.readFileSync(snapshotPath).equals(snapshotBytes)) throw new core.ClockError('FROZEN_INPUT_CHANGED_DURING_RENDER');
  checkOutput(options.output);
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.mkdirSync(options.output);
  const manifest = {
    schemaVersion: 'orion-stale-clock-summary-chart-files-v1',
    status: summary.status, preparedAt: new Date().toISOString(),
    sourceCsvSha256: charts.CSV_SHA256, sourceSnapshotSha256: charts.SNAPSHOT_SHA256,
    requests: 0, files: {}
  };
  for (const [name, body] of Object.entries(files)) {
    const bytes = Buffer.from(body, 'utf8');
    fs.writeFileSync(path.join(options.output, name), bytes, { flag: 'wx', mode: 0o600 });
    manifest.files[name] = { sha256: core.sha256(bytes), bytes: bytes.length };
  }
  // Written last. A failure leaves an incomplete directory, never a resealed one.
  fs.writeFileSync(path.join(options.output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: summary.status, output: options.output, files: Object.keys(files).concat('manifest.json'), requests: 0 };
}
if (require.main === module) {
  try { const result = main(); process.stdout.write(result.help || JSON.stringify(result, null, 2) + '\n'); }
  catch (error) { process.stderr.write((error instanceof core.ClockError ? error.code : 'LOCAL_CHART_OUTPUT_FAILED') + '\n'); process.exitCode = 1; }
}
module.exports = { parseArguments, checkOutput, main };

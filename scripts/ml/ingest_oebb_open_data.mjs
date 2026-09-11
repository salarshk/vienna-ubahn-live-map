#!/usr/bin/env node

// Ingest the official ÖBB MMTIS downloads. The portal requires accepting its
// terms before exposing the ZIP URLs, so the URLs are intentionally supplied
// by the operator rather than guessed or scraped.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../..');
const OUTPUT_DIR = resolve(ROOT, process.env.OEBB_DATA_DIR || 'data/ml/oebb');
const RUN_DATE = new Date().toISOString().slice(0, 10);
const RUN_DIR = resolve(OUTPUT_DIR, RUN_DATE);

const sources = [
  { key: 'zugfahrten', url: process.env.OEBB_ZUGFAHRTEN_URL },
  { key: 'netex', url: process.env.OEBB_NETEX_URL },
].filter((source) => source.url);

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
};

const splitCsvLine = (line, delimiter) => {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      cells.push(value); value = '';
    } else value += character;
  }
  cells.push(value);
  return cells.map((cell) => cell.trim());
};

const csvRows = (text) => {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headerLine = lines[0];
  const delimiter = (headerLine.match(/;/g) || []).length > (headerLine.match(/,/g) || []).length ? ';' : ',';
  const headers = splitCsvLine(headerLine, delimiter).map((header) => header.toLowerCase());
  return lines.slice(1).map((line, rowIndex) => {
    const cells = splitCsvLine(line, delimiter);
    const row = Object.fromEntries(headers.map((header, index) => [header || `column_${index}`, cells[index] ?? '']));
    return { rowIndex: rowIndex + 2, ...row };
  });
};

const findValue = (row, terms) => {
  const key = Object.keys(row).find((candidate) => terms.some((term) => candidate.includes(term)));
  return key ? row[key] : null;
};

const normaliseTrainRun = (row, sourceFile) => ({
  source: 'oebb-zugfahrten',
  sourceFile,
  sourceRow: row.rowIndex,
  trainId: findValue(row, ['zugnummer', 'trainnumber', 'train_id', 'trip_id', 'fahrt']),
  line: findValue(row, ['linie', 'line', 'route']),
  station: findValue(row, ['haltestelle', 'bahnhof', 'station', 'stop']),
  serviceDate: findValue(row, ['datum', 'date', 'betriebstag']),
  plannedTime: findValue(row, ['plan', 'scheduled', 'soll']),
  actualTime: findValue(row, ['ist', 'actual', 'real', 'ankunft']),
  delaySeconds: findValue(row, ['verspaet', 'delay', 'abweich']),
  cancelled: /ausfall|cancel|storno/i.test(Object.values(row).join(' ')),
  raw: row,
});

const inspectExtractedFiles = async (source, extractionDir) => {
  const files = await walk(extractionDir);
  const records = [];
  const fileSummaries = [];
  for (const file of files) {
    const info = await stat(file);
    const relative = file.slice(extractionDir.length + 1);
    const summary = { file: relative, bytes: info.size };
    if (/\.csv$/i.test(file)) {
      const text = await readFile(file, 'utf8');
      const rows = csvRows(text);
      summary.rows = rows.length;
      if (source.key === 'zugfahrten') records.push(...rows.map((row) => normaliseTrainRun(row, relative)));
    }
    fileSummaries.push(summary);
  }
  return { files: fileSummaries, records };
};

if (!sources.length) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(resolve(OUTPUT_DIR, 'collection-health.json'), `${JSON.stringify({
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    status: 'skipped',
    reason: 'No accepted ÖBB ZIP URL was configured.',
    sourcePage: 'https://data.oebb.at/de/datensaetze~datenbereitstellung_delegierte_verordnung_eu_2024-490~',
  }, null, 2)}\n`);
  console.log(JSON.stringify({
    skipped: true,
    reason: 'Set OEBB_ZUGFAHRTEN_URL and/or OEBB_NETEX_URL to the accepted official ZIP URLs.',
    sourcePage: 'https://data.oebb.at/de/datensaetze~datenbereitstellung_delegierte_verordnung_eu_2024-490~',
  }, null, 2));
  process.exit(0);
}

await mkdir(RUN_DIR, { recursive: true });
const manifest = {
  schemaVersion: 1,
  collectedAt: new Date().toISOString(),
  sourcePage: 'https://data.oebb.at/de/datensaetze~datenbereitstellung_delegierte_verordnung_eu_2024-490~',
  sources: [],
};
const allTrainRuns = [];

for (const source of sources) {
  const zipPath = resolve(RUN_DIR, `${source.key}.zip`);
  const extractionDir = resolve(RUN_DIR, source.key);
  const response = await fetch(source.url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`ÖBB ${source.key} download returned HTTP ${response.status}`);
  await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
  await mkdir(extractionDir, { recursive: true });
  await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', extractionDir]);
  const inspected = await inspectExtractedFiles(source, extractionDir);
  allTrainRuns.push(...inspected.records);
  manifest.sources.push({ key: source.key, url: source.url, zip: zipPath.slice(ROOT.length + 1), ...inspected });
}

await writeFile(resolve(RUN_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
if (allTrainRuns.length) {
  await writeFile(resolve(RUN_DIR, 'zugfahrten.normalized.jsonl'), `${allTrainRuns.map((row) => JSON.stringify(row)).join('\n')}\n`);
}
console.log(JSON.stringify({
  skipped: false,
  collectedAt: manifest.collectedAt,
  sources: manifest.sources.map(({ key, files }) => ({ key, files: files.length })),
  normalizedTrainRuns: allTrainRuns.length,
  output: RUN_DIR,
}, null, 2));

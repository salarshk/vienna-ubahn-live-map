#!/usr/bin/env node

// Ingest the official ÖBB MMTIS downloads. The portal requires accepting its
// terms before exposing the ZIP URLs, so the URLs are intentionally supplied
// by the operator rather than guessed or scraped.
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
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

const numberValue = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const delaySecondsFromRow = (row, actualKey, plannedKey, delayMinutesKey) => {
  const explicitMinutes = numberValue(row[delayMinutesKey]);
  if (explicitMinutes !== null) return Math.round(explicitMinutes * 60);
  const actual = Date.parse(String(row[actualKey] || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  const planned = Date.parse(String(row[plannedKey] || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(actual) && Number.isFinite(planned) ? Math.round((actual - planned) / 1000) : null;
};

const normaliseTrainRun = (row, sourceFile) => ({
  source: 'oebb-zugfahrten',
  sourceFile,
  sourceRow: row.rowIndex,
  recordType: /ausgefallen/i.test(sourceFile)
    ? 'cancelled'
    : /verspaetet/i.test(sourceFile)
      ? 'delayed'
      : 'train-run',
  trainId: row.zugnummer || findValue(row, ['trainnumber', 'train_id', 'trip_id', 'fahrt']),
  line: findValue(row, ['linie', 'line', 'route']),
  station: row.start_betriebsstelle || findValue(row, ['haltestelle', 'bahnhof', 'station', 'stop']),
  destinationStation: row.ziel_betriebsstelle || null,
  serviceDate: row.betriebstag || findValue(row, ['datum', 'date']),
  plannedTime: row.abfahrtzeit_soll || findValue(row, ['plan', 'scheduled', 'soll']),
  actualTime: row.abfahrtzeit_ist || findValue(row, ['actual', 'real', 'ist']),
  arrivalPlannedTime: row.ankunftzeit_soll || null,
  arrivalActualTime: row.ankunftzeit_ist || null,
  departureDelaySeconds: delaySecondsFromRow(row, 'abfahrtzeit_ist', 'abfahrtzeit_soll', 'abfahrt_verspaetung_min'),
  arrivalDelaySeconds: delaySecondsFromRow(row, 'ankunftzeit_ist', 'ankunftzeit_soll', 'ankunft_verspaetung_min'),
  delaySeconds: delaySecondsFromRow(row, 'ankunftzeit_ist', 'ankunftzeit_soll', 'ankunft_verspaetung_min')
    ?? delaySecondsFromRow(row, 'abfahrtzeit_ist', 'abfahrtzeit_soll', 'abfahrt_verspaetung_min'),
  cancelled: /ausgefallen|ausfall|cancel|storno/i.test(sourceFile) || /ausfall|cancel|storno/i.test(Object.values(row).join(' ')),
  // The original CSV is preserved inside the downloaded ZIP. Avoid copying
  // every source cell into the normalized JSONL by default; set
  // OEBB_INCLUDE_RAW=true only when a forensic row-level copy is needed.
  ...(process.env.OEBB_INCLUDE_RAW === 'true' ? { raw: row } : {}),
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
  const isLocalPath = source.url.startsWith('file://') || !/^[a-z][a-z\d+.-]*:\/\//i.test(source.url);
  if (isLocalPath) {
    const localPath = source.url.startsWith('file://') ? new URL(source.url) : source.url;
  await writeFile(zipPath, await readFile(localPath));
  } else {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`ÖBB ${source.key} download returned HTTP ${response.status}`);
    await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
  }
  await mkdir(extractionDir, { recursive: true });
  await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', extractionDir]);
  const inspected = await inspectExtractedFiles(source, extractionDir);
  // Avoid spreading hundreds of thousands of weekly CSV rows into a single
  // function call; large ÖBB archives otherwise exceed the JS call stack.
  for (const record of inspected.records) allTrainRuns.push(record);
  // Keep the manifest compact: the normalized records are written separately
  // and must not be duplicated inside manifest.json.
  manifest.sources.push({
    key: source.key,
    url: source.url,
    zip: zipPath.slice(ROOT.length + 1),
    files: inspected.files,
    normalizedRecords: inspected.records.length,
  });
}

await writeFile(resolve(RUN_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
if (allTrainRuns.length) {
  const normalizedPath = resolve(RUN_DIR, 'zugfahrten.normalized.jsonl');
  await writeFile(normalizedPath, '');
  // Write bounded chunks so a large multi-week ZIP never exceeds V8's
  // maximum string length while joining the complete archive.
  for (let index = 0; index < allTrainRuns.length; index += 5000) {
    const chunk = allTrainRuns.slice(index, index + 5000)
      .map((row) => JSON.stringify(row))
      .join('\n');
    await appendFile(normalizedPath, `${chunk}\n`);
  }
}
console.log(JSON.stringify({
  skipped: false,
  collectedAt: manifest.collectedAt,
  sources: manifest.sources.map(({ key, files }) => ({ key, files: files.length })),
  normalizedTrainRuns: allTrainRuns.length,
  output: RUN_DIR,
}, null, 2));

#!/usr/bin/env node

// Carefully join ÖBB train-run records to the annual GTFS train number and
// NeTEx operating-point code. MMTIS records only origin/destination points;
// never present the result as full intermediate-stop punctuality.
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const archiveDir = resolve(root, process.env.OEBB_DATA_DIR || 'data/ml/oebb');
const outputPath = resolve(archiveDir, 'sbahn-punctuality.json');
const runs = resolve(archiveDir, new Date().toISOString().slice(0, 10));
const gtfsZip = process.env.OEBB_GTFS_ZIP;
const netexZip = process.env.OEBB_NETEX_ZIP || join(runs, 'netex.zip');
const normalized = join(runs, 'zugfahrten.normalized.jsonl');
const diagnostics = { normalizedRows: 0, lineMatches: 0, pointMatches: 0, acceptedRecords: 0, stationCoverage: 0 };
const publish = async (status, reason, rows = []) => {
  await mkdir(archiveDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, status, generatedAt: new Date().toISOString(), source: 'ÖBB-Infrastruktur AG MMTIS train runs + annual GTFS + NeTEx', coverage: 'Last 30 days, recorded origin and destination operating points only; not every intermediate S-Bahn stop.', reason, diagnostics: { ...diagnostics, stationCoverage: new Set(rows.map((row) => row.station)).size }, rows }, null, 2)}\n`);
  console.log(JSON.stringify({ status, reason, diagnostics, outputPath }));
};

const listZip = async (path) => (await exec('unzip', ['-Z', '-1', path], { maxBuffer: 16 * 1024 * 1024 })).stdout.split(/\r?\n/);
const readZip = async (path, name) => (await exec('unzip', ['-p', path, name], { maxBuffer: 128 * 1024 * 1024 })).stdout;
const parseCsvLine = (line) => {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { cells.push(value); value = ''; }
    else value += character;
  }
  cells.push(value);
  return cells;
};
const csv = (text) => {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift() || '');
  return lines.map((line) => Object.fromEntries(parseCsvLine(line).map((value, index) => [headers[index], value])));
};
const clean = (value) => String(value || '').trim().toLocaleLowerCase('de-AT');

try {
  if (!gtfsZip) throw new Error('OEBB_GTFS_ZIP is not configured; an annual GTFS train-number join is required.');
  const [gtfsFiles, netexFiles, sbahn] = await Promise.all([
    listZip(gtfsZip), listZip(netexZip), readFile(resolve(root, 'src/data/sbahn_network.json'), 'utf8').then(JSON.parse),
  ]);
  const gtfsFile = (name) => gtfsFiles.find((file) => file.endsWith(`/${name}`) || file === name);
  const siteframe = netexFiles.find((file) => /SITEFRAME.*\.xml$/i.test(file));
  if (!gtfsFile('routes.txt') || !gtfsFile('trips.txt') || !siteframe) throw new Error('Required GTFS routes/trips or NeTEx SiteFrame is missing.');
  const [routesText, tripsText, siteText] = await Promise.all([
    readZip(gtfsZip, gtfsFile('routes.txt')),
    readZip(gtfsZip, gtfsFile('trips.txt')),
    readZip(netexZip, siteframe),
  ]);
  // Train numbers may be reused by non-S services. A number is safe to label
  // S-Bahn only when every GTFS trip bearing it has the same S route label.
  const routes = new Map(csv(routesText).map((row) => [row.route_id, row.route_short_name]));
  const trainLines = new Map();
  for (const trip of csv(tripsText)) {
    const line = routes.get(trip.route_id);
    const train = String(trip.trip_short_name || '').trim();
    if (!/^\d+$/.test(train)) continue;
    const set = trainLines.get(train) || new Set();
    set.add(line || '(unknown route)');
    trainLines.set(train, set);
  }
  const knownStations = new Map(sbahn.features.filter((feature) => feature.geometry?.type === 'Point')
    .map((feature) => [clean(feature.properties.name), feature.properties.name]));
  const codeNames = new Map();
  for (const match of siteText.matchAll(/<StopPlace\b[^>]*>([\s\S]*?)<\/StopPlace>/g)) {
    const body = match[1];
    const name = body.match(/<Name(?:\s[^>]*)?>([^<]+)<\/Name>/)?.[1]?.replace(/^Wien\s+/i, '').split(',')[0].trim();
    const shortName = body.match(/<ShortName>([^<]+)<\/ShortName>/)?.[1];
    const station = knownStations.get(clean(name));
    if (!station || !shortName) continue;
    for (const code of shortName.split(',').map(clean)) {
      const set = codeNames.get(code) || new Set();
      set.add(station);
      codeNames.set(code, set);
    }
  }
  const groups = new Map();
  const seen = new Set();
  const cutoffDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const input = createInterface({ input: createReadStream(normalized), crlfDelay: Infinity });
  for await (const line of input) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    diagnostics.normalizedRows += 1;
    if (String(record.serviceDate || '') < cutoffDate) continue;
    const lineSet = trainLines.get(String(record.trainId || '').trim());
    if (!lineSet || lineSet.size !== 1 || !/^S\d+$/.test([...lineSet][0])) continue;
    diagnostics.lineMatches += 1;
    const sbahnLine = [...lineSet][0];
    for (const point of [
      { code: record.station, at: record.plannedTime, delay: record.departureDelaySeconds, kind: 'departure' },
      { code: record.destinationStation, at: record.arrivalPlannedTime, delay: record.arrivalDelaySeconds, kind: 'arrival' },
    ]) {
      const names = codeNames.get(clean(point.code));
      if (!names || names.size !== 1 || !Number.isFinite(point.delay)) continue;
      diagnostics.pointMatches += 1;
      const timestamp = Date.parse(String(point.at || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
      if (!Number.isFinite(timestamp)) continue;
      const unique = `${record.trainId}|${record.serviceDate}|${point.code}|${point.kind}|${point.at}`;
      if (seen.has(unique)) continue;
      seen.add(unique);
      const station = [...names][0];
      const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vienna', hour: '2-digit', hourCycle: 'h23' }).format(timestamp);
      const key = `${station}|${sbahnLine}|${hour}|${point.kind}`;
      const group = groups.get(key) || { station, line: sbahnLine, hour: Number(hour), kind: point.kind, observations: 0, delaySumSeconds: 0, delayedOverFiveMinutes: 0 };
      group.observations += 1;
      group.delaySumSeconds += point.delay;
      group.delayedOverFiveMinutes += point.delay > 300 ? 1 : 0;
      groups.set(key, group);
      diagnostics.acceptedRecords += 1;
    }
  }
  const rows = [...groups.values()].filter((row) => row.observations >= 3).map((row) => ({
    ...row, meanDelaySeconds: Math.round(row.delaySumSeconds / row.observations),
    overFivePercent: Math.round(100 * row.delayedOverFiveMinutes / row.observations),
  })).sort((a, b) => a.line.localeCompare(b.line) || a.station.localeCompare(b.station) || a.hour - b.hour);
  await publish(rows.length ? 'ready' : 'unavailable', rows.length ? null : 'No S-line train-number and Vienna operating-point joins passed the minimum evidence threshold.', rows);
} catch (error) {
  await publish('unavailable', error.message);
}

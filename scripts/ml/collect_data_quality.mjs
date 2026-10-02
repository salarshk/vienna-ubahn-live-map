#!/usr/bin/env node

// Produce a compact, machine-readable freshness and completeness report for
// every collection layer.  This is intentionally separate from model metrics:
// a good score cannot compensate for a stale or partial source.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const DATA = resolve(ROOT, 'data/ml');
const OUT = resolve(ROOT, process.env.DATA_QUALITY_PATH || 'data/ml/data-quality.json');
const now = Date.now();

const files = async (directory, suffix = '') => {
  try { return (await readdir(directory, { recursive: true })).filter((name) => String(name).endsWith(suffix)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const parse = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const jsonlStats = async (directory) => {
  const names = await files(directory, '.jsonl');
  let rows = 0; let latest = null; let earliest = null; let live = 0; const stations = new Set();
  for (const name of names) {
    const text = await readFile(resolve(directory, name), 'utf8');
    for (const line of text.split('\n').filter(Boolean)) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      rows += 1;
      const at = Number(row.observedAt || row.collectedAt || row.timestamp);
      if (Number.isFinite(at)) { latest = latest == null ? at : Math.max(latest, at); earliest = earliest == null ? at : Math.min(earliest, at); }
      if (row.isLive || row.realTime || row.realtimeSupported) live += 1;
      if (row.stationId != null) stations.add(String(row.stationId));
    }
  }
  return { files: names.length, rows, stations: stations.size, liveRows: live, earliest, latest, ageMinutes: latest == null ? null : Math.round(Math.max(0, now - latest) / 60000) };
};
const jsonStats = async (directory) => {
  const names = await files(directory, '.json');
  let snapshots = 0; let latest = null; let earliest = null; let rows = 0;
  for (const name of names) {
    const value = await parse(resolve(directory, name));
    if (!value) continue;
    snapshots += 1;
    const at = Number(value.generatedAt || value.collectedAt || value.observedAt);
    if (Number.isFinite(at)) { latest = latest == null ? at : Math.max(latest, at); earliest = earliest == null ? at : Math.min(earliest, at); }
    rows += Array.isArray(value.observations) ? value.observations.length : Array.isArray(value.traffic?.observations) ? value.traffic.observations.length : 0;
  }
  return { snapshots, rows, earliest, latest, ageMinutes: latest == null ? null : Math.round(Math.max(0, now - latest) / 60000) };
};

const observations = await jsonlStats(resolve(DATA, 'observations'));
const worker = await jsonStats(resolve(DATA, 'worker-snapshots'));
const mobility = await jsonStats(resolve(DATA, 'context', 'mobility-worker'));
const collectedMobility = await jsonStats(resolve(DATA, 'context', 'mobility'));
const weather = await jsonlStats(resolve(DATA, 'context'));
const health = await parse(resolve(DATA, 'collection-health.json'));
const observationFiles = await files(resolve(DATA, 'observations'), '.jsonl');
let labels = { delayActual: 0, trafficJam: 0, incidentContext: 0, exactGps: 0, crowdProxy: 0, cancellation: 'not available', transferOutcome: 'not available', eventAttendance: 'not available' };
for (const name of observationFiles) {
  const text = await readFile(resolve(DATA, 'observations', name), 'utf8');
  for (const line of text.split('\n').filter(Boolean)) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (Number.isFinite(Number(row.officialDelaySeconds ?? row.reportedDelaySeconds))) labels.delayActual += 1;
    if (row.trafficJam) labels.trafficJam += 1;
    if (Number(row.activeIncidentCount) > 0 || row.delayRelatedIncident) labels.incidentContext += 1;
    if (row.exactGpsAvailable) labels.exactGps += 1;
    if (row.stationName && row.line) labels.crowdProxy += 1;
  }
}
const warnings = [];
if (!observations.rows) warnings.push('no U-Bahn observation rows');
if (worker.snapshots && worker.ageMinutes > 15) warnings.push('Worker snapshots are older than 15 minutes');
if (!worker.snapshots) warnings.push('no Worker snapshots restored from R2');
if (mobility.snapshots && mobility.ageMinutes > 20) warnings.push('mobility context is older than 20 minutes');
if (health && health.batchesFailed > 0) warnings.push(`${health.batchesFailed} Wiener Linien station batches failed`);

const report = {
  schemaVersion: 1,
  generatedAt: new Date(now).toISOString(),
  status: warnings.length ? 'watch' : 'healthy',
  sources: {
    ubahn: observations,
    workerSnapshots: worker,
    mobilityContextWorker: mobility,
    mobilityContextCollector: collectedMobility,
    weatherContext: weather,
    sbahn: { status: 'blocked-live-source', note: 'ÖBB timetable/archive data is retained; no live vehicle-delay feed is connected.' },
  },
  collectionHealth: health ? { status: health.status, stationsRequested: health.stationsRequested, stationsSuccessful: health.stationsSuccessful, rowsCollected: health.rowsCollected } : null,
  labels,
  warnings,
};
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));

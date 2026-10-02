#!/usr/bin/env node

// Turn the five-minute Cloudflare Worker snapshots into the same observation
// shape used by the delay trainer.  The import is deterministic and rewrites
// only worker-* partitions, so rerunning after an R2 restore cannot duplicate
// rows.  S-Bahn and tram observations are deliberately excluded here: their
// labels have different provenance and remain separate datasets.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const INPUT_DIR = resolve(ROOT, process.env.WORKER_SNAPSHOTS_DIR || 'data/ml/worker-snapshots');
const OUTPUT_DIR = resolve(ROOT, process.env.DELAY_OBSERVATIONS_DIR || 'data/ml/observations');
const LINES = new Set(['U1', 'U2', 'U3', 'U4', 'U6']);

const filesRecursive = async (directory) => {
  try {
    return (await readdir(directory, { recursive: true })).filter((name) => String(name).endsWith('.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const timestamp = (value) => finite(value) ?? Date.parse(value || '');
const eventKey = (row) => [row.stationId, row.line, row.direction || 'unknown', row.destination, row.plannedTime].join('|');
const journeyKey = (row) => [row.line, row.direction || 'unknown', row.destination || 'unknown', row.plannedTime].join('|');

const partitions = new Map();
const seen = new Set();
let snapshotCount = 0;
for (const relative of await filesRecursive(INPUT_DIR)) {
  let snapshot;
  try { snapshot = JSON.parse(await readFile(resolve(INPUT_DIR, relative), 'utf8')); } catch { continue; }
  const observedAt = timestamp(snapshot.generatedAt);
  if (!Number.isFinite(observedAt) || !Array.isArray(snapshot.observations)) continue;
  snapshotCount += 1;
  for (const item of snapshot.observations) {
    if (!LINES.has(String(item.line))) continue;
    const plannedMs = timestamp(item.plannedTimestamp || item.plannedTime);
    const realMs = timestamp(item.realtimeTimestamp || item.realTime);
    if (!Number.isFinite(plannedMs) || !Number.isFinite(realMs)) continue;
    const secondsToReal = Math.round((realMs - observedAt) / 1000);
    if (secondsToReal < -120 || secondsToReal > 900) continue;
    const row = {
      schemaVersion: 4,
      observedAt,
      stationId: item.stationId ?? null,
      stationName: item.stationName || String(item.stationId || 'Unknown station'),
      line: String(item.line),
      direction: item.direction || null,
      destination: item.destination || 'Unknown destination',
      plannedTime: new Date(plannedMs).toISOString(),
      realTime: new Date(realMs).toISOString(),
      reportedDelaySeconds: finite(item.reportedDelaySeconds),
      officialDelaySeconds: finite(item.reportedDelaySeconds),
      delaySource: 'wiener-linien-shared-worker-snapshot',
      secondsToPlanned: Math.round((plannedMs - observedAt) / 1000),
      secondsToReal,
      countdownMinutes: finite(item.countdownSeconds) == null ? null : Number(item.countdownSeconds) / 60,
      realtimeSupported: true,
      vehicleId: item.vehicleId || null,
      exactGpsCoordinates: null,
      exactGpsAvailable: false,
      positionSource: 'inferred-from-departure-prediction',
      positionConfidence: 0.45,
      feedServerTime: null,
      feedAgeSeconds: Math.max(0, Math.round((observedAt - Number(item.fetchedAt || observedAt)) / 1000)),
    };
    row.eventKey = eventKey(row);
    row.journeyKey = journeyKey(row);
    const unique = `${observedAt}|${row.eventKey}`;
    if (seen.has(unique)) continue;
    seen.add(unique);
    const day = new Date(observedAt).toISOString().slice(0, 10);
    const list = partitions.get(day) || [];
    list.push(row);
    partitions.set(day, list);
  }
}

await mkdir(OUTPUT_DIR, { recursive: true });
for (const [day, rows] of partitions) {
  rows.sort((a, b) => a.observedAt - b.observedAt || a.eventKey.localeCompare(b.eventKey));
  await writeFile(resolve(OUTPUT_DIR, `worker-${day}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}
console.log(JSON.stringify({ source: 'cloudflare-worker-snapshots', snapshots: snapshotCount, rows: seen.size, partitions: partitions.size, output: OUTPUT_DIR }));

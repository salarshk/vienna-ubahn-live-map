#!/usr/bin/env node

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { incidentFeaturesAt, normaliseLiveTrafficInfos } from './incident_features.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const STATIONS_PATH = resolve(ROOT, 'src/data/paradas_api.json');
const OUTPUT_DIR = resolve(
  ROOT,
  process.env.DELAY_OBSERVATIONS_DIR || 'data/ml/observations',
);
const API_BASE = String(
  process.env.VIENNA_API_BASE || 'https://www.wienerlinien.at/ogd_realtime',
).replace(/\/$/, '');
const U_BAHN_LINES = new Set(['U1', 'U2', 'U3', 'U4', 'U6']);
// Evenly distributed reference stations used by the map's position engine.
// Sampling the complete 99-station network would repeat the same train at
// every downstream stop and make the longitudinal artifact needlessly large.
const REFERENCE_STATION_IDS = new Set([
  60201481, 60201095, 60200657, 60201040, 60200031, 60201860, 60201859,
  60200910, 60200299, 60201299, 60201894, 60201182, 60201430,
  60201317, 60201468, 60201320, 60200743, 60201199, 60200425,
  60200956, 60200520, 60200820, 60201198, 60200357, 60201062,
  60201007, 60201499, 60201015, 60200615, 60201510, 60201705, 60201668,
]);
const BATCH_SIZE = 24;
const RETENTION_DAYS = 30;

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

const parseTimestamp = (value) => {
  if (!value) return NaN;
  return Date.parse(String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
};

const eventKey = (row) => [
  row.stationId,
  row.line,
  row.direction || 'unknown',
  row.destination,
  row.plannedTime,
].join('|');

const readExistingRows = async (outputPath) => {
  try {
    const text = await readFile(outputPath, 'utf8');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const fetchBatch = async (stations) => {
  const query = stations.map(({ id }) => `diva=${encodeURIComponent(id)}`).join('&');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${API_BASE}/monitor?${query}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'vienna-ubahn-delay-research/1.0 (+https://github.com/salarshk/vienna-ubahn-live-map)',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (response.ok) {
      const payload = await response.json();
      return Array.isArray(payload?.data?.monitors) ? payload.data.monitors : [];
    }
    const retryable = response.status === 403 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) {
      throw new Error(`Wiener Linien monitor request returned HTTP ${response.status}`);
    }
    await response.body?.cancel();
    await sleep(5000 * (attempt + 1));
  }
  return [];
};

const fetchCurrentIncidents = async (observedAt) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}/trafficInfoList`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'vienna-ubahn-delay-research/1.0 (+https://github.com/salarshk/vienna-ubahn-live-map)',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) return normaliseLiveTrafficInfos(await response.json(), observedAt);
      const retryable = response.status === 403 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) throw new Error(`HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      if (attempt === 2) {
        console.warn(`Current incident context unavailable: ${error.message}`);
        return [];
      }
    }
    await sleep(5000 * (attempt + 1));
  }
  return [];
};

const rowsFromMonitors = (monitors, observedAt, incidents) => monitors.flatMap((monitor) => {
  const stop = monitor?.locationStop?.properties || {};
  const stationId = Number(stop.name);
  const stationName = String(stop.title || '').replace(/\s+U$/, '') || String(stationId);
  return (monitor.lines || []).flatMap((line) => {
    const lineId = String(line.name || '');
    if (!U_BAHN_LINES.has(lineId)) return [];
    return (line.departures?.departure || []).flatMap((departure) => {
      const timing = departure.departureTime || {};
      const plannedMs = parseTimestamp(timing.timePlanned);
      const realMs = parseTimestamp(timing.timeReal);
      if (!Number.isFinite(plannedMs) || !Number.isFinite(realMs)) return [];
      const vehicle = departure.vehicle || {};
      const direction = String(vehicle.direction || line.direction || '').toUpperCase();
      const incidentContext = incidentFeaturesAt(incidents, lineId, observedAt);
      const row = {
        schemaVersion: 1,
        observedAt,
        stationId,
        stationName,
        line: lineId,
        direction: direction === 'H' || direction === 'R' ? direction : null,
        destination: vehicle.towards || line.towards || 'Unknown destination',
        plannedTime: new Date(plannedMs).toISOString(),
        realTime: new Date(realMs).toISOString(),
        reportedDelaySeconds: Math.round((realMs - plannedMs) / 1000),
        secondsToPlanned: Math.round((plannedMs - observedAt) / 1000),
        secondsToReal: Math.round((realMs - observedAt) / 1000),
        countdownMinutes: Number.isFinite(Number(timing.countdown)) ? Number(timing.countdown) : null,
        realtimeSupported: line.realtimeSupported !== false,
        trafficJam: Boolean(vehicle.trafficjam ?? line.trafficjam),
        barrierFree: vehicle.barrierFree ?? line.barrierFree ?? null,
        ...incidentContext,
      };
      row.eventKey = eventKey(row);
      // We need an early feature observation and a near-departure label. Rows
      // farther away cannot contribute to either and only inflate storage.
      return row.secondsToReal >= -120 && row.secondsToReal <= 900 ? [row] : [];
    });
  });
});

const stations = JSON.parse(await readFile(STATIONS_PATH, 'utf8'))
  .filter((station) => Number.isFinite(Number(station.id)))
  .map((station) => ({ id: Number(station.id), name: station.nombre }))
  .filter((station) => REFERENCE_STATION_IDS.has(station.id))
  .filter((station, index, all) => all.findIndex((candidate) => candidate.id === station.id) === index);

const observedAt = Date.now();
const currentIncidents = await fetchCurrentIncidents(observedAt);
const observationDate = new Date(observedAt).toISOString().slice(0, 10);
const outputPath = resolve(OUTPUT_DIR, `${observationDate}.jsonl`);
const collectedRows = [];
for (let index = 0; index < stations.length; index += BATCH_SIZE) {
  const batch = stations.slice(index, index + BATCH_SIZE);
  const monitors = await fetchBatch(batch);
  collectedRows.push(...rowsFromMonitors(monitors, observedAt, currentIncidents));
  if (index + BATCH_SIZE < stations.length) await sleep(1100);
}

const cutoff = observedAt - RETENTION_DAYS * 86400000;
const existingRows = (await readExistingRows(outputPath)).filter((row) => Number(row.observedAt) >= cutoff);
const merged = [...existingRows, ...collectedRows];
const deduplicated = [...new Map(merged.map((row) => [
  `${row.observedAt}|${row.eventKey}`,
  row,
])).values()].sort((a, b) => a.observedAt - b.observedAt || a.eventKey.localeCompare(b.eventKey));

await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(outputPath, `${deduplicated.map((row) => JSON.stringify(row)).join('\n')}\n`);
const oldestDate = new Date(cutoff).toISOString().slice(0, 10);
for (const file of await readdir(OUTPUT_DIR)) {
  if (file.endsWith('.jsonl') && file.slice(0, 10) < oldestDate) await unlink(resolve(OUTPUT_DIR, file));
}

const liveRows = collectedRows.filter((row) => row.realtimeSupported).length;
console.log(JSON.stringify({
  observedAt: new Date(observedAt).toISOString(),
  stationsRequested: stations.length,
  rowsCollected: collectedRows.length,
  liveRows,
  activeUbahnIncidentRecords: currentIncidents.length,
  totalRowsRetained: deduplicated.length,
  output: outputPath,
}, null, 2));

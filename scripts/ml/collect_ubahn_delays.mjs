#!/usr/bin/env node

import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { incidentFeaturesAt, normaliseLiveTrafficInfos } from './incident_features.mjs';
import { detectHeadwayEvents, reconcileHeadwayEvents } from './headway_events.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const STATIONS_PATH = resolve(ROOT, 'src/data/paradas_api.json');
const OUTPUT_DIR = resolve(
  ROOT,
  process.env.DELAY_OBSERVATIONS_DIR || 'data/ml/observations',
);
const RAW_OUTPUT_DIR = resolve(
  ROOT,
  process.env.DELAY_RAW_DIR || 'data/ml/raw',
);
const HEADWAY_EVENT_DIR = resolve(
  ROOT,
  process.env.HEADWAY_EVENTS_DIR || 'data/ml/headway-events',
);
const HEADWAY_STATE_PATH = resolve(
  ROOT,
  process.env.HEADWAY_STATE_PATH || 'data/ml/headway-state.json',
);
const API_BASE = String(
  process.env.VIENNA_API_BASE || 'https://www.wienerlinien.at/ogd_realtime',
).replace(/\/$/, '');
const U_BAHN_LINES = new Set(['U1', 'U2', 'U3', 'U4', 'U6']);
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

const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
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
      return {
        monitors: Array.isArray(payload?.data?.monitors) ? payload.data.monitors : [],
        serverTime: payload?.message?.serverTime || payload?.data?.message?.serverTime || null,
        payload,
      };
    }
    const retryable = response.status === 403 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) {
      throw new Error(`Wiener Linien monitor request returned HTTP ${response.status}`);
    }
    await response.body?.cancel();
    await sleep(5000 * (attempt + 1));
  }
  return { monitors: [], serverTime: null, payload: null };
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
      if (response.ok) {
        const payload = await response.json();
        return { records: normaliseLiveTrafficInfos(payload, observedAt), payload };
      }
      const retryable = response.status === 403 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) throw new Error(`HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      if (attempt === 2) {
        console.warn(`Current incident context unavailable: ${error.message}`);
        return { records: [], payload: null };
      }
    }
    await sleep(5000 * (attempt + 1));
  }
  return { records: [], payload: null };
};

const fetchNews = async () => {
  const url = `${API_BASE}/newsList?name=news&name=aufzugsservice`;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'vienna-ubahn-delay-research/1.0' },
      signal: AbortSignal.timeout(30000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};

const rowsFromMonitors = (monitors, observedAt, incidents, feedServerTime = null) => monitors.flatMap((monitor) => {
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
      const gpsCandidate = vehicle.gpsCoordinates || vehicle.coordinates || vehicle.position?.coordinates || null;
      const exactGpsCoordinates = Array.isArray(gpsCandidate) && gpsCandidate.length >= 2
        ? gpsCandidate.slice(0, 2).map(Number)
        : null;
      const validExactGpsCoordinates = exactGpsCoordinates?.every(Number.isFinite)
        ? exactGpsCoordinates : null;
      const direction = String(vehicle.direction || line.direction || '').toUpperCase();
      const incidentContext = incidentFeaturesAt(incidents, lineId, observedAt);
      const row = {
        schemaVersion: 3,
        observedAt,
        stationId,
        stationName,
        line: lineId,
        direction: direction === 'H' || direction === 'R' ? direction : null,
        destination: vehicle.towards || line.towards || 'Unknown destination',
        plannedTime: new Date(plannedMs).toISOString(),
        realTime: new Date(realMs).toISOString(),
        reportedDelaySeconds: Math.round((realMs - plannedMs) / 1000),
        officialDelaySeconds: Math.round((realMs - plannedMs) / 1000),
        delaySource: 'wiener-linien-timeReal-minus-timePlanned',
        secondsToPlanned: Math.round((plannedMs - observedAt) / 1000),
        secondsToReal: Math.round((realMs - observedAt) / 1000),
        countdownMinutes: Number.isFinite(Number(timing.countdown)) ? Number(timing.countdown) : null,
        realtimeSupported: line.realtimeSupported !== false,
        trafficJam: Boolean(vehicle.trafficjam ?? line.trafficjam),
        barrierFree: vehicle.barrierFree ?? line.barrierFree ?? null,
        platform: line.platform ?? vehicle.platform ?? stop.gate ?? null,
        gate: stop.gate ?? null,
        rbl: stop.rbl ?? stop.name ?? null,
        lineId: line.linienId ?? line.lineId ?? null,
        routeDirectionId: vehicle.richtungsId ?? line.richtungsId ?? null,
        vehicleId: vehicle.id || vehicle.vehicleId || null,
        vehicleName: vehicle.name || null,
        vehicleType: vehicle.type || null,
        onStop: vehicle.onStop ?? null,
        foldingRamp: vehicle.foldingRamp ?? null,
        cooling: vehicle.cooling ?? null,
        exactGpsCoordinates: validExactGpsCoordinates,
        exactGpsAvailable: Boolean(validExactGpsCoordinates),
        positionSource: validExactGpsCoordinates ? 'official-vehicle-gps' : 'inferred-from-departure-prediction',
        feedServerTime,
        feedAgeSeconds: feedServerTime && Number.isFinite(parseTimestamp(feedServerTime))
          ? Math.max(0, Math.round((observedAt - parseTimestamp(feedServerTime)) / 1000))
          : null,
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
  .filter((station, index, all) => all.findIndex((candidate) => candidate.id === station.id) === index);

const observedAt = Date.now();
const currentIncidentContext = await fetchCurrentIncidents(observedAt);
const currentIncidents = currentIncidentContext.records;
const newsPayload = await fetchNews();
const observationDate = new Date(observedAt).toISOString().slice(0, 10);
const outputPath = resolve(OUTPUT_DIR, `${observationDate}.jsonl`);
const collectedRows = [];
for (let index = 0; index < stations.length; index += BATCH_SIZE) {
  const batch = stations.slice(index, index + BATCH_SIZE);
  const monitorPayload = await fetchBatch(batch);
  collectedRows.push(...rowsFromMonitors(
    monitorPayload.monitors,
    observedAt,
    currentIncidents,
    monitorPayload.serverTime,
  ));
  if (index + BATCH_SIZE < stations.length) await sleep(1100);
}

const cutoff = observedAt - RETENTION_DAYS * 86400000;
const existingRows = (await readExistingRows(outputPath)).filter((row) => Number(row.observedAt) >= cutoff);
const merged = [...existingRows, ...collectedRows];
const deduplicated = [...new Map(merged.map((row) => [
  `${row.observedAt}|${row.eventKey}`,
  row,
])).values()].sort((a, b) => a.observedAt - b.observedAt || a.eventKey.localeCompare(b.eventKey));

const headwayState = await readJson(HEADWAY_STATE_PATH, {});
const currentHeadwayEvents = detectHeadwayEvents(collectedRows, observedAt);
const reconciledHeadway = reconcileHeadwayEvents({
  current: currentHeadwayEvents,
  state: headwayState,
  observedAt,
});

await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(outputPath, `${deduplicated.map((row) => JSON.stringify(row)).join('\n')}\n`);
await mkdir(RAW_OUTPUT_DIR, { recursive: true });
await appendFile(resolve(RAW_OUTPUT_DIR, `${observationDate}.jsonl`), `${JSON.stringify({
  observedAt,
  source: 'wiener-linien',
  incidentPayload: currentIncidentContext.payload,
  newsPayload,
})}\n`);
await mkdir(HEADWAY_EVENT_DIR, { recursive: true });
if (reconciledHeadway.observations.length) {
  await appendFile(
    resolve(HEADWAY_EVENT_DIR, `${observationDate}.jsonl`),
    `${reconciledHeadway.observations.map((event) => JSON.stringify({
      schemaVersion: 1,
      source: 'wiener-linien-monitor',
      archivedAt: observedAt,
      ...event,
    })).join('\n')}\n`,
  );
}
await writeFile(HEADWAY_STATE_PATH, `${JSON.stringify(reconciledHeadway.state, null, 2)}\n`);
const oldestDate = new Date(cutoff).toISOString().slice(0, 10);
for (const file of await readdir(OUTPUT_DIR)) {
  if (file.endsWith('.jsonl') && file.slice(0, 10) < oldestDate) await unlink(resolve(OUTPUT_DIR, file));
}
for (const file of await readdir(RAW_OUTPUT_DIR)) {
  if (file.endsWith('.jsonl') && file.slice(0, 10) < oldestDate) await unlink(resolve(RAW_OUTPUT_DIR, file));
}
for (const file of await readdir(HEADWAY_EVENT_DIR)) {
  if (file.endsWith('.jsonl') && file.slice(0, 10) < oldestDate) await unlink(resolve(HEADWAY_EVENT_DIR, file));
}

const liveRows = collectedRows.filter((row) => row.realtimeSupported).length;
console.log(JSON.stringify({
  observedAt: new Date(observedAt).toISOString(),
  stationsRequested: stations.length,
  rowsCollected: collectedRows.length,
  liveRows,
  activeUbahnIncidentRecords: currentIncidents.length,
  fullStationCoverage: stations.length,
  newsPayloadCollected: Boolean(newsPayload),
  headwayEventsObserved: currentHeadwayEvents.length,
  headwayLifecycleRowsWritten: reconciledHeadway.observations.length,
  totalRowsRetained: deduplicated.length,
  output: outputPath,
}, null, 2));

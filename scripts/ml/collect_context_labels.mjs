#!/usr/bin/env node

/* Archive keyless environmental labels next to the official rail rows.
 * Weather is a real, timestamped public observation. It is kept separate from
 * the train feed so an outage never prevents rail collection. The operational
 * registry joins these hourly rows to official delay labels; it does not turn
 * a weather correlation into a causal claim.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const OBSERVATION_DIR = resolve(ROOT, process.env.DELAY_OBSERVATIONS_DIR || 'data/ml/observations');
const OUTPUT_DIR = resolve(ROOT, process.env.CONTEXT_LABELS_DIR || 'data/ml/context');
const WEATHER_PATH = resolve(OUTPUT_DIR, 'weather.jsonl');
const LATITUDE = 48.2082;
const LONGITUDE = 16.3738;

const readJsonlDir = async (directory) => {
  try {
    const files = (await readdir(directory)).filter((file) => file.endsWith('.jsonl')).sort();
    const texts = await Promise.all(files.map((file) => readFile(resolve(directory, file), 'utf8')));
    return texts.flatMap((text) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const day = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);
const rows = await readJsonlDir(OBSERVATION_DIR);
const timestamps = rows.map((row) => Number(row.observedAt)).filter(Number.isFinite);
const end = timestamps.length ? new Date(Math.max(...timestamps)) : new Date();
const start = timestamps.length ? new Date(Math.min(...timestamps)) : new Date(end.getTime() - 14 * 86400000);
const startDate = day(start);
const endDate = day(end);
const url = new URL('https://archive-api.open-meteo.com/v1/archive');
url.search = new URLSearchParams({
  latitude: String(LATITUDE), longitude: String(LONGITUDE), start_date: startDate, end_date: endDate,
  hourly: 'temperature_2m,precipitation,rain,snowfall,wind_speed_10m,weather_code', timezone: 'UTC',
}).toString();

let payload = null;
try {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Open-Meteo archive returned HTTP ${response.status}`);
  payload = await response.json();
} catch (error) {
  console.warn(`Weather label archive unavailable; keeping previous rows (${error.message})`);
  process.exit(0);
}

const hourly = payload?.hourly || {};
const times = Array.isArray(hourly.time) ? hourly.time : [];
const fields = ['temperature_2m', 'precipitation', 'rain', 'snowfall', 'wind_speed_10m', 'weather_code'];
const fresh = times.map((time, index) => ({
  schemaVersion: 1,
  observedAt: Date.parse(`${time}:00Z`),
  time,
  source: 'Open-Meteo historical archive',
  latitude: LATITUDE,
  longitude: LONGITUDE,
  temperatureC: Number(hourly.temperature_2m?.[index]),
  precipitationMm: Number(hourly.precipitation?.[index]),
  rainMm: Number(hourly.rain?.[index]),
  snowfallMm: Number(hourly.snowfall?.[index]),
  windSpeedKmh: Number(hourly.wind_speed_10m?.[index]),
  weatherCode: Number(hourly.weather_code?.[index]),
})).filter((row) => Number.isFinite(row.observedAt));

let existing = [];
try { existing = (await readFile(WEATHER_PATH, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const merged = new Map([...existing, ...fresh].map((row) => [row.observedAt, row]));
await mkdir(dirname(WEATHER_PATH), { recursive: true });
await writeFile(WEATHER_PATH, `${[...merged.values()].sort((a, b) => a.observedAt - b.observedAt).map((row) => JSON.stringify(row)).join('\n')}\n`);
console.log(JSON.stringify({ source: 'Open-Meteo historical archive', startDate, endDate, rows: merged.size, output: WEATHER_PATH }));

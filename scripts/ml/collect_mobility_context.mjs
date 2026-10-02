#!/usr/bin/env node

// Collect one compact urban-context snapshot for model joins.  The script can
// use the deployed Worker relay or the public Vienna WFS directly; optional
// EVIS/event values are never fabricated when credentials are missing.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const base = String(process.env.VIENNA_API_BASE || '').replace(/\/$/, '');
const fallback = 'https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0&typeName=ogdwien:DAUERZAEHLOGD&srsName=EPSG:4326&outputFormat=json';
const timeout = (ms = 12000) => AbortSignal.timeout?.(ms);
const get = async (url) => {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: timeout() });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

let payload;
try {
  payload = base ? await get(`${base}/mobility-context`) : { generatedAt: Date.now(), traffic: { counterLocations: await get(fallback), status: 'catalog-only', valuesStatus: 'not connected' }, events: { status: 'not configured', records: [] } };
} catch (error) {
  console.error(`Mobility context unavailable: ${error.message}`);
  process.exitCode = 0;
  process.exit();
}

const now = new Date(Number(payload.generatedAt) || Date.now());
const folder = resolve(root, 'data/ml/context/mobility', now.toISOString().slice(0, 10));
await mkdir(folder, { recursive: true });
const compact = {
  schemaVersion: 1,
  collectedAt: now.toISOString(),
  source: payload.source || 'vienna-mobility-context-relay',
  traffic: payload.traffic || null,
  events: payload.events || null,
  sources: payload.sources || {},
};
const file = resolve(folder, `${now.toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(file, `${JSON.stringify(compact)}\n`);
console.log(`Saved mobility context snapshot: ${file}`);

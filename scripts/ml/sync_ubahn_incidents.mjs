#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { compactIncidentArchive } from './incident_features.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const OUTPUT_PATH = resolve(ROOT, process.env.DELAY_INCIDENTS_PATH || 'data/ml/ubahn-incidents.json');
const SOURCE_URL = process.env.WIENER_LINIEN_INCIDENT_ARCHIVE_URL
  || 'https://cipfileshareprod.blob.core.windows.net/wlcip/WL_Incidents_2026-02-18_12-44-32.json';
const SOURCE_CATALOG_URL = 'https://www.mobilitaetsdaten.gv.at/daten/daten-zu-versp%C3%A4tungen-und-ausf%C3%A4llen-im-linienverkehr';

const readExisting = async () => {
  try {
    return JSON.parse(await readFile(OUTPUT_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const existing = await readExisting();
let head;
try {
  head = await fetch(SOURCE_URL, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
  if (!head.ok) throw new Error(`HTTP ${head.status}`);
} catch (error) {
  if (existing) {
    console.warn(`Incident archive check failed; keeping the existing import (${error.message}).`);
    process.exit(0);
  }
  console.warn(`Incident archive is unavailable; departure collection can continue (${error.message}).`);
  process.exit(0);
}

const etag = head.headers.get('etag');
if (existing?.sourceUrl === SOURCE_URL && etag && existing.sourceEtag === etag) {
  if (!existing.sourceCatalogUrl) {
    await writeFile(OUTPUT_PATH, `${JSON.stringify({ ...existing, sourceCatalogUrl: SOURCE_CATALOG_URL })}\n`);
  }
  console.log(JSON.stringify({ changed: false, episodes: existing.ubahnEpisodeCount, sourceEtag: etag }, null, 2));
  process.exit(0);
}

const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(180000) });
if (!response.ok) throw new Error(`Incident archive returned HTTP ${response.status}`);
const payload = await response.json();
const compact = compactIncidentArchive(payload, {
  url: SOURCE_URL,
  catalogUrl: SOURCE_CATALOG_URL,
  etag: response.headers.get('etag') || etag,
  lastModified: response.headers.get('last-modified') || head.headers.get('last-modified'),
});

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
const temporaryPath = `${OUTPUT_PATH}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(compact)}\n`);
await rename(temporaryPath, OUTPUT_PATH);
console.log(JSON.stringify({
  changed: true,
  episodes: compact.ubahnEpisodeCount,
  byLine: compact.byLine,
  sourceEntities: compact.sourceEntityCount,
  output: OUTPUT_PATH,
}, null, 2));

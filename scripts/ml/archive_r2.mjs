#!/usr/bin/env node

// Durable archive bridge for Cloudflare R2's S3-compatible API.
// GitHub Actions artifacts remain a short-lived recovery layer; R2 keeps the
// dated observations after those artifacts expire.
import { access, appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../..');
const mode = process.argv[2];
const DATA_DIR = resolve(ROOT, 'data/ml');
const OEBB_DIR = resolve(DATA_DIR, 'oebb');
const endpoint = process.env.R2_ENDPOINT
  || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
const bucket = String(process.env.R2_BUCKET || '').trim();
const prefix = String(process.env.R2_PREFIX || 'vienna-rail').replace(/^\/|\/$/g, '');
const trainingWindowDays = Math.max(7, Math.min(90, Number(process.env.R2_TRAIN_WINDOW_DAYS) || 21));
const credentialsAvailable = Boolean(
  endpoint && bucket && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY,
);

const writeOutput = async (name, value) => {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
};

const s3Path = (...parts) => `s3://${bucket}/${[prefix, ...parts].filter(Boolean).join('/')}`;

const runAws = async (args) => {
  const env = {
    ...process.env,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || 'auto',
    AWS_REGION: process.env.AWS_REGION || 'auto',
  };
  await execFileAsync('aws', [...args, '--endpoint-url', endpoint, '--no-progress', '--only-show-errors'], {
    cwd: ROOT,
    env,
    maxBuffer: 1024 * 1024 * 8,
  });
};

const directoryExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const hasFiles = async (path) => {
  try {
    return (await readdir(path, { recursive: true })).length > 0;
  } catch {
    return false;
  }
};

const writeArchiveHealth = async (dataset, status = 'ok', details = {}) => {
  const healthPath = resolve(DATA_DIR, 'r2-health.json');
  const payload = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    dataset,
    status,
    bucket,
    prefix,
    ...details,
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(healthPath, `${JSON.stringify(payload, null, 2)}\n`);
  await runAws(['s3', 'cp', healthPath, s3Path('health', `${dataset}.json`)]);
};

const syncDirectory = async (source, destination) => {
  if (!(await directoryExists(source))) return false;
  await runAws(['s3', 'sync', source, destination]);
  return true;
};

const syncRecentDates = async (sourcePrefix, destination) => {
  const today = Math.floor(Date.now() / 86400000);
  // Dated partitions stay in R2 indefinitely. Only the recent window is
  // hydrated on a daily training runner, so startup cost does not grow forever.
  for (let offset = trainingWindowDays - 1; offset >= 0; offset -= 1) {
    const day = new Date((today - offset) * 86400000).toISOString().slice(0, 10);
    await runAws(['s3', 'sync', `${sourcePrefix}/${day}`, resolve(destination, day)]);
  }
};

if (!['download-ubahn', 'upload-ubahn', 'upload-model', 'upload-oebb'].includes(mode)) {
  throw new Error('Usage: archive_r2.mjs <download-ubahn|upload-ubahn|upload-model|upload-oebb>');
}

if (!credentialsAvailable) {
  if (mode !== 'download-ubahn') throw new Error('R2 archive credentials are missing; the long-term upload cannot be skipped.');
  console.log('R2 restore skipped: configure R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
  await writeOutput('r2_restored', 'false');
  process.exit(0);
}

if (mode === 'download-ubahn') {
  await mkdir(DATA_DIR, { recursive: true });
  await runAws(['s3', 'sync', s3Path('rolling', 'ubahn'), DATA_DIR,
    '--exclude', 'worker-snapshots/*', '--exclude', 'observations/worker-*']);
  await runAws(['s3', 'sync', s3Path('archive', 'ubahn', 'context'), resolve(DATA_DIR, 'context')]);
  // Worker cron snapshots are archived at five-minute cadence and are the
  // highest-volume source for chronological model joins.
  await syncRecentDates(s3Path('mobility-context'), resolve(DATA_DIR, 'context', 'mobility-worker'));
  await syncRecentDates(s3Path('worker-snapshots'), resolve(DATA_DIR, 'worker-snapshots'));
  // Older Worker deployments wrote at bucket root; keep those historical
  // objects visible to training without changing or deleting the archive.
  await syncRecentDates(`s3://${bucket}/mobility-context`, resolve(DATA_DIR, 'context', 'mobility-worker'));
  await syncRecentDates(`s3://${bucket}/worker-snapshots`, resolve(DATA_DIR, 'worker-snapshots'));
  const restored = await hasFiles(DATA_DIR);
  console.log(restored
    ? 'Restored the rolling U-Bahn dataset from Cloudflare R2.'
    : 'No rolling U-Bahn dataset exists in Cloudflare R2 yet.');
  await writeOutput('r2_restored', String(restored));
  process.exit(0);
}

if (mode === 'upload-ubahn') {
  // No --delete is used: the R2 archive remains append-only even when local
  // ML files expire after the rolling training window.
  await runAws(['s3', 'sync', DATA_DIR, s3Path('rolling', 'ubahn'),
    '--exclude', 'worker-snapshots/*', '--exclude', 'observations/worker-*']);
  await syncDirectory(resolve(DATA_DIR, 'observations'), s3Path('archive', 'ubahn', 'observations'));
  await syncDirectory(resolve(DATA_DIR, 'raw'), s3Path('archive', 'ubahn', 'raw'));
  await syncDirectory(resolve(DATA_DIR, 'headway-events'), s3Path('archive', 'ubahn', 'headway-events'));
  await syncDirectory(resolve(DATA_DIR, 'context'), s3Path('archive', 'ubahn', 'context'));
  await writeArchiveHealth('ubahn');
  console.log('Archived the U-Bahn rolling dataset and dated partitions to Cloudflare R2.');
  process.exit(0);
}

if (mode === 'upload-model') {
  const date = new Date().toISOString().slice(0, 10);
  const version = String(process.env.GITHUB_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-'));
  for (const name of ['candidate-model.json', 'candidate-metrics.json', 'operational-models.json',
    'operational-validation.json', 'collection-health.json', 'data-quality.json']) {
    const source = resolve(DATA_DIR, name);
    if (!(await directoryExists(source))) continue;
    await runAws(['s3', 'cp', source, s3Path('models', 'daily', date, version, name)]);
    await runAws(['s3', 'cp', source, s3Path('models', 'latest', name)]);
  }
  await writeArchiveHealth('models');
  console.log('Archived the validated model report and its dated R2 version.');
  process.exit(0);
}

await syncDirectory(OEBB_DIR, s3Path('archive', 'oebb'));
const sbahnSummary = resolve(OEBB_DIR, 'sbahn-punctuality.json');
if (await directoryExists(sbahnSummary)) {
  // Publish unavailable/awaiting-join diagnostics too, so the public panel
  // does not imply that a missing GTFS input is merely still collecting.
  await runAws(['s3', 'cp', sbahnSummary, `s3://${bucket}/rail-history/sbahn-punctuality.json`]);
}
await writeArchiveHealth('oebb');
console.log('Archived the ÖBB dated dataset to Cloudflare R2.');

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

if (!['download-ubahn', 'upload-ubahn', 'upload-oebb'].includes(mode)) {
  throw new Error('Usage: archive_r2.mjs <download-ubahn|upload-ubahn|upload-oebb>');
}

if (!credentialsAvailable) {
  console.log('R2 archive skipped: configure R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
  await writeOutput('r2_restored', 'false');
  process.exit(0);
}

if (mode === 'download-ubahn') {
  await mkdir(DATA_DIR, { recursive: true });
  await runAws(['s3', 'sync', s3Path('rolling', 'ubahn'), DATA_DIR]);
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
  await syncDirectory(DATA_DIR, s3Path('rolling', 'ubahn'));
  await syncDirectory(resolve(DATA_DIR, 'observations'), s3Path('archive', 'ubahn', 'observations'));
  await syncDirectory(resolve(DATA_DIR, 'raw'), s3Path('archive', 'ubahn', 'raw'));
  await syncDirectory(resolve(DATA_DIR, 'headway-events'), s3Path('archive', 'ubahn', 'headway-events'));
  await writeArchiveHealth('ubahn');
  console.log('Archived the U-Bahn rolling dataset and dated partitions to Cloudflare R2.');
  process.exit(0);
}

await syncDirectory(OEBB_DIR, s3Path('archive', 'oebb'));
await writeArchiveHealth('oebb');
console.log('Archived the ÖBB dated dataset to Cloudflare R2.');

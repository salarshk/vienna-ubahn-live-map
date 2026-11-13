#!/usr/bin/env node
// Fetches the offline basemap: a PMTiles extract of the Vienna region plus
// the glyphs and sprites its style needs.
//
// The app is a Vienna rail map and nothing else, so the basemap it needs is
// one region rather than a planet — small enough to ship with the app and read
// from disk with no network at all. On the web the same archive is read by HTTP
// range request, so a visitor downloads the few tiles they look at rather than
// the whole file.
//
// Like the GTFS Feed (ADR-0003), this is refetchable input rather than
// committed data: 34 MB of binary does not belong in git history. The app falls
// back to online raster tiles when it is absent, so a fresh clone still shows a
// map — just one that stops resolving past zoom 16.
//
//   npm run fetch:basemap

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// The network's own bounding box is lon -0.590..-0.326, lat 39.084..39.623.
// Padded so panning off the end of a line does not run off the edge of the map.
const BBOX = '15.80,47.95,16.90,48.55';

const PMTILES_VERSION = '1.31.2';
const ASSETS = 'https://protomaps.github.io/basemaps-assets';

// Latin plus the punctuation range. Valencian and Spanish place names live
// entirely in the first two; the third carries the dashes and quotes labels use.
const FONTSTACKS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
const RANGES = ['0-255', '256-511', '8192-8447'];

// One sprite per theme the app builds a style for — see THEME_FLAVOURS in MapView.
const SPRITES = ['white', 'dark'];

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'public', 'basemap');
const cacheDir = path.join(root, '.cache');

const download = async (url, destination) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  return fs.statSync(destination).size;
};

// Protomaps publishes a build a day. Today's may not exist yet depending on the
// hour, so walk back until one does rather than pinning a date that will rot.
const findLatestBuild = async () => {
  for (let daysBack = 0; daysBack < 21; daysBack++) {
    const day = new Date(Date.now() - daysBack * 86400000);
    const stamp = day.toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://build.protomaps.com/${stamp}.pmtiles`;
    const response = await fetch(url, { method: 'HEAD' });
    if (response.ok) return url;
  }
  throw new Error('No Protomaps daily build found in the last 21 days');
};

// The extract is a range-request walk over a 100 GB remote archive, which is
// the Go tool's job rather than something worth reimplementing here.
const ensurePmtilesCli = async () => {
  const cached = path.join(cacheDir, 'pmtiles');
  if (fs.existsSync(cached)) return cached;

  const platform = os.platform() === 'darwin' ? 'Darwin' : 'Linux';
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
  // The release uses ZIP archives on macOS/Windows and tar.gz on Linux.
  const isLinux = platform === 'Linux';
  const asset = isLinux
    ? `go-pmtiles_${PMTILES_VERSION}_${platform}_${arch}.tar.gz`
    : `go-pmtiles-${PMTILES_VERSION}_${platform}_${arch}.zip`;
  const url = `https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${asset}`;

  console.log(`  fetching the pmtiles CLI (${platform}/${arch})`);
  const archive = path.join(cacheDir, asset);
  await download(url, archive);
  if (isLinux) {
    execFileSync('tar', ['-xzf', archive, '-C', cacheDir]);
  } else {
    execFileSync('unzip', ['-o', '-q', archive, 'pmtiles', '-d', cacheDir]);
  }
  fs.chmodSync(cached, 0o755);
  fs.unlinkSync(archive);
  return cached;
};

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const cli = await ensurePmtilesCli();
  const build = await findLatestBuild();
  console.log(`Extracting ${BBOX} from ${build}`);

  const archive = path.join(outDir, 'vienna.pmtiles');
  execFileSync(cli, ['extract', build, archive, `--bbox=${BBOX}`], { stdio: 'inherit' });
  console.log(`  ${path.relative(root, archive)} — ${mb(fs.statSync(archive).size)}`);

  let glyphBytes = 0;
  for (const fontstack of FONTSTACKS) {
    for (const range of RANGES) {
      glyphBytes += await download(
        `${ASSETS}/fonts/${encodeURIComponent(fontstack)}/${range}.pbf`,
        path.join(outDir, 'fonts', fontstack, `${range}.pbf`)
      );
    }
  }
  console.log(`  fonts — ${mb(glyphBytes)} across ${FONTSTACKS.length * RANGES.length} files`);

  let spriteBytes = 0;
  for (const sprite of SPRITES) {
    for (const extension of ['json', 'png']) {
      spriteBytes += await download(
        `${ASSETS}/sprites/v4/${sprite}.${extension}`,
        path.join(outDir, 'sprites', `${sprite}.${extension}`)
      );
    }
  }
  console.log(`  sprites — ${mb(spriteBytes)}`);
  console.log('Done. `npm run build` then `npx cap sync ios` puts it in the app.');
})().catch((error) => {
  console.error(`fetch:basemap failed — ${error.message}`);
  process.exit(1);
});

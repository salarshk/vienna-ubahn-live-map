// Build the compact Vienna U-Bahn dataset used by the app from Wiener Linien
// Open Government Data. The source files are downloaded at build time and are
// intentionally not committed; only the small derived JSON files ship.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vienna-ubahn-'));

const BASE = 'https://www.wienerlinien.at/ogd_realtime/doku/ogd';
const sources = {
  stops: `${BASE}/wienerlinien-ogd-haltestellen.csv`,
  platforms: `${BASE}/wienerlinien-ogd-haltepunkte.csv`,
  routes: `${BASE}/wienerlinien-ogd-linien.csv`,
  paths: `${BASE}/wienerlinien-ogd-fahrwegverlaeufe.csv`,
};

const lineByOperatorId = {
  '301': 'U1',
  '302': 'U2',
  '303': 'U3',
  '304': 'U4',
  '306': 'U6',
};

const colors = {
  U1: '#E20613',
  U2: '#A762A3',
  U3: '#EF7C00',
  U4: '#009540',
  U6: '#9D6930',
};

const speeds = { U1: 10.4, U2: 9.6, U3: 10.0, U4: 9.2, U6: 8.5 };
const dwellSeconds = 20;

const parseSemicolon = (text) => {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(';');
  return lines.slice(1).map((line) => {
    const values = line.split(';');
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
};

const download = (name, url) => {
  const target = path.join(tempDir, `${name}.csv`);
  execFileSync('curl', ['-sSL', '--fail', '--max-time', '90', '-o', target, url], { stdio: 'inherit' });
  return fs.readFileSync(target, 'utf8');
};

const haversine = (a, b) => {
  const radius = 6371000;
  const radians = Math.PI / 180;
  const dLat = (b[1] - a[1]) * radians;
  const dLon = (b[0] - a[0]) * radians;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
};

const writeJson = (relativePath, value) => {
  const target = path.join(projectRoot, relativePath);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`Wrote ${relativePath}`);
};

try {
  const stopRows = parseSemicolon(download('stops', sources.stops));
  const platformRows = parseSemicolon(download('platforms', sources.platforms));
  const routeRows = parseSemicolon(download('routes', sources.routes));
  const pathRows = parseSemicolon(download('paths', sources.paths));

  const stopByDiva = new Map(stopRows.map((row) => [row.DIVA, row]));
  const platformById = new Map(platformRows.map((row) => [row.StopID, row]));
  const routeById = new Map(routeRows.map((row) => [row.LineID, row]));

  const lines = [];
  const stationsByDiva = new Map();
  const timingLines = {};

  for (const [operatorId, lineId] of Object.entries(lineByOperatorId)) {
    // Pattern 1 / direction 1 is the complete outbound chain in the current
    // Wiener Linien OGD export. The file also contains legacy four-column
    // duplicates; requiring Direction filters those out.
    const chain = pathRows
      .filter((row) => row.LineID === operatorId && row.PatternID === '1' && row.Direction === '1')
      .sort((a, b) => Number(a.StopSeqCount) - Number(b.StopSeqCount))
      .map((row) => platformById.get(row.StopID))
      .filter(Boolean);

    if (chain.length < 2) throw new Error(`No complete path found for ${lineId}`);

    const stationChain = chain.map((platform) => {
      const master = stopByDiva.get(platform.DIVA) || platform;
      const longitude = Number(platform.Longitude || master.Longitude);
      const latitude = Number(platform.Latitude || master.Latitude);
      const name = master.PlatformText || platform.StopText;

      if (!stationsByDiva.has(platform.DIVA)) {
        stationsByDiva.set(platform.DIVA, {
          diva: platform.DIVA,
          name,
          longitude: Number(master.Longitude || longitude),
          latitude: Number(master.Latitude || latitude),
          lines: new Set(),
        });
      }
      stationsByDiva.get(platform.DIVA).lines.add(lineId);
      return { diva: platform.DIVA, name, coordinates: [longitude, latitude] };
    });

    const terminals = [stationChain[0].name, stationChain[stationChain.length - 1].name];
    const route = routeById.get(operatorId);
    lines.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: stationChain.map((station) => station.coordinates) },
      properties: {
        line: lineId,
        name: `${lineId}: ${terminals[0]} – ${terminals[1]}`,
        color: colors[lineId],
        operatorLineId: Number(operatorId),
        realtime: route ? route.Realtime === '1' : true,
        terminals,
      },
    });

    const segments = {};
    for (let index = 0; index < stationChain.length - 1; index += 1) {
      const from = stationChain[index];
      const to = stationChain[index + 1];
      const running = Math.max(35, Math.round(haversine(from.coordinates, to.coordinates) / speeds[lineId]));
      const seconds = running + dwellSeconds;
      segments[`${from.diva}>${to.diva}`] = seconds;
      segments[`${to.diva}>${from.diva}`] = seconds;
    }
    timingLines[lineId] = {
      segments,
      segmentCount: Object.keys(segments).length / 2,
      fallback: { metresPerSecond: speeds[lineId], minSeconds: 55, samples: stationChain.length - 1 },
    };
  }

  const stations = [...stationsByDiva.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .map((station) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [station.longitude, station.latitude] },
      properties: {
        type: 'station',
        id: `st-${station.diva}`,
        name: station.name,
        stop_id: station.diva,
        apiId: Number(station.diva),
        lines: [...station.lines].sort(),
        zone: 'Wien',
      },
    }));

  const featureCollection = { type: 'FeatureCollection', features: [...lines, ...stations] };
  writeJson('src/data/metro_lines.json', { type: 'FeatureCollection', features: lines });
  writeJson('src/data/gtfs_expanded.json', featureCollection);
  writeJson('src/data/paradas_api.json', stations.map((station) => ({
    id: station.properties.apiId,
    nombre: station.properties.name,
    latitud: station.geometry.coordinates[1],
    longitud: station.geometry.coordinates[0],
  })));
  writeJson('src/data/line_colors_from_image.json', colors);
  writeJson('src/data/segment_times.json', {
    generatedAt: new Date().toISOString(),
    source: 'Wiener Linien Open Government Data',
    note: 'Estimated U-Bahn segment times derived from official stop sequences and line-specific commercial speeds.',
    dwellSeconds,
    networkFallback: { metresPerSecond: 9.5, minSeconds: 55, samples: stations.length },
    lines: timingLines,
  });

  console.log(`${lines.length} U-Bahn lines, ${stations.length} stations`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

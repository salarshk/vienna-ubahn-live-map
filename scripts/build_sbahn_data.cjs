// Build a compact Vienna S-Bahn map and timetable from ÖBB's official GTFS.
//
// Usage:
//   OEBB_GTFS_ZIP=/path/to/GTFS_Fahrplan_2026.zip npm run build:sbahn
//
// Without OEBB_GTFS_ZIP the current annual feed is downloaded temporarily.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vienna-sbahn-'));
const downloadedZip = path.join(tempDir, 'oebb-gtfs.zip');
const zipPath = process.env.OEBB_GTFS_ZIP || downloadedZip;
const GTFS_URL_TEMPLATE = 'https://static.web.oebb.at/open-data/soll-fahrplan-gtfs/GTFS_Fahrplan_YEAR.zip';
const WIENER_STOPS_URL = 'https://www.wienerlinien.at/ogd_realtime/doku/ogd/wienerlinien-ogd-haltestellen.csv';
let selectedFeedYear = null;
let archivePrefix = null;

const S_LINES = new Set(['S1', 'S2', 'S3', 'S4', 'S7', 'S40', 'S45', 'S50', 'S60', 'S80']);
const COLORS = {
  S1: '#00AEEF', S2: '#FF6B6B', S3: '#C084FC', S4: '#5DD39E', S7: '#FFB547',
  S40: '#5BC0EB', S45: '#E879F9', S50: '#A3E635', S60: '#FB923C', S80: '#2DD4BF',
};

// City boundary plus a small fringe so trains do not disappear exactly at the
// municipal edge. The app is a Vienna map, not an all-Austria rail map.
const BOUNDS = { west: 16.13, south: 48.08, east: 16.63, north: 48.36 };

const parseCsvLine = (line) => {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
};

const parseCsv = (text, separator = ',') => {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (separator === ';') {
    const headers = lines[0].split(';');
    return lines.slice(1).map((line) => {
      const values = line.split(';');
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
    });
  }
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
};

const discoverArchivePrefix = () => {
  if (archivePrefix !== null) return archivePrefix;
  const files = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).split(/\r?\n/);
  const routesPath = files.find((filename) => filename.endsWith('/routes.txt')) || files.find((filename) => filename === 'routes.txt');
  if (!routesPath) throw new Error('The downloaded archive does not contain routes.txt');
  archivePrefix = routesPath.slice(0, -'routes.txt'.length);
  const year = routesPath.match(/GTFS_Fahrplan_(\d{4})/);
  if (year) selectedFeedYear = Number(year[1]);
  return archivePrefix;
};

const readZip = (filename) => execFileSync(
  'unzip', ['-p', zipPath, `${discoverArchivePrefix()}${filename}`],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
);

const downloadLatestAnnualFeed = () => {
  const currentYear = new Date().getUTCFullYear();
  const candidates = process.env.OEBB_GTFS_URL
    ? [{ year: null, url: process.env.OEBB_GTFS_URL }]
    : [currentYear + 1, currentYear].map((year) => ({
      year,
      url: GTFS_URL_TEMPLATE.replace('YEAR', String(year)),
    }));

  for (const candidate of candidates) {
    try {
      console.log(`Trying ${candidate.url}`);
      execFileSync('curl', ['-sSL', '--fail', '--max-time', '240', '-o', zipPath, candidate.url], { stdio: 'inherit' });
      selectedFeedYear = candidate.year;
      return;
    } catch {
      console.warn(`Feed unavailable: ${candidate.url}`);
    }
  }
  throw new Error('No current ÖBB annual GTFS feed could be downloaded');
};

const seconds = (value) => {
  const [hours, minutes, secs] = String(value || '').split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) && Number.isFinite(secs)
    ? hours * 3600 + minutes * 60 + secs
    : null;
};

const inBounds = (stop) => {
  const longitude = Number(stop.stop_lon);
  const latitude = Number(stop.stop_lat);
  return longitude >= BOUNDS.west && longitude <= BOUNDS.east &&
    latitude >= BOUNDS.south && latitude <= BOUNDS.north;
};

const displayName = (name) => String(name || '')
  .replace(/^Wien\s+/i, '')
  .replace(/\s+Bahnhof$/i, '')
  .trim();

const haversine = (a, b) => {
  const radius = 6371000;
  const radians = Math.PI / 180;
  const dLat = (b[1] - a[1]) * radians;
  const dLon = (b[0] - a[0]) * radians;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
};

try {
  if (!process.env.OEBB_GTFS_ZIP) {
    downloadLatestAnnualFeed();
  }
  if (!fs.existsSync(zipPath)) throw new Error(`GTFS zip not found: ${zipPath}`);
  discoverArchivePrefix();

  const routes = parseCsv(readZip('routes.txt'));
  const selectedRoutes = new Map(routes
    .filter((route) => route.agency_id === '01' && S_LINES.has(route.route_short_name) && /-W-/.test(route.route_id))
    .map((route) => [route.route_id, route.route_short_name]));

  const trips = parseCsv(readZip('trips.txt'))
    .filter((trip) => selectedRoutes.has(trip.route_id));
  const tripById = new Map(trips.map((trip) => [trip.trip_id, trip]));
  const stopTimesByTrip = new Map(trips.map((trip) => [trip.trip_id, []]));

  for (const row of parseCsv(readZip('stop_times.txt'))) {
    if (stopTimesByTrip.has(row.trip_id)) stopTimesByTrip.get(row.trip_id).push(row);
  }

  const stopRows = parseCsv(readZip('stops.txt'));
  const stopById = new Map(stopRows.map((stop) => [stop.stop_id, stop]));
  const cityTrips = [];
  const stationById = new Map();
  const chainsByLine = new Map([...S_LINES].map((line) => [line, []]));

  for (const [tripId, rows] of stopTimesByTrip) {
    const trip = tripById.get(tripId);
    const line = selectedRoutes.get(trip.route_id);
    const chain = [];
    rows.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));

    for (const row of rows) {
      const platform = stopById.get(row.stop_id);
      if (!platform) continue;
      const station = stopById.get(platform.parent_station) || platform;
      if (!inBounds(station)) continue;
      const stationId = station.stop_id;
      const arrival = seconds(row.arrival_time);
      const departure = seconds(row.departure_time);
      if (arrival === null || departure === null) continue;
      if (chain.at(-1)?.[2] === stationId) continue;

      chain.push([arrival, departure, stationId]);
      if (!stationById.has(stationId)) {
        stationById.set(stationId, {
          id: stationId,
          name: displayName(station.stop_name),
          coordinates: [Number(station.stop_lon), Number(station.stop_lat)],
          lines: new Set(),
        });
      }
      stationById.get(stationId).lines.add(line);
    }

    if (chain.length < 2) continue;
    cityTrips.push({
      id: tripId,
      line,
      service: trip.service_id,
      direction: Number(trip.direction_id || 0),
      destination: displayName(trip.trip_headsign),
      stops: chain,
    });
    chainsByLine.get(line).push(chain.map((point) => point[2]));
  }

  // Attach Wiener Linien DIVA ids where the S-Bahn station also appears in
  // Vienna's stop catalogue. This gives station panels planned departures.
  const wienerText = execFileSync(
    'curl', ['-sSL', '--fail', '--max-time', '90', WIENER_STOPS_URL],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  const wienerStops = parseCsv(wienerText, ';')
    .map((stop) => ({
      id: Number(stop.DIVA),
      name: stop.PlatformText,
      coordinates: [Number(stop.Longitude), Number(stop.Latitude)],
    }))
    .filter((stop) => stop.id && stop.coordinates.every(Number.isFinite));

  for (const station of stationById.values()) {
    let nearest = null;
    for (const stop of wienerStops) {
      const distance = haversine(station.coordinates, stop.coordinates);
      if (!nearest || distance < nearest.distance) nearest = { ...stop, distance };
    }
    if (nearest && nearest.distance <= 350) station.apiId = nearest.id;
  }

  const lineFeatures = [];
  for (const line of [...S_LINES].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const chains = chainsByLine.get(line);
    // The longest in-city stopping pattern is the clearest single map path for
    // a line with express/short-turn variants.
    const canonical = chains.sort((a, b) => b.length - a.length)[0];
    if (!canonical) continue;
    const stations = canonical.map((id) => stationById.get(id)).filter(Boolean);
    lineFeatures.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: stations.map((station) => station.coordinates) },
      properties: {
        line,
        mode: 'sbahn',
        name: `${line}: ${stations[0].name} – ${stations.at(-1).name}`,
        color: COLORS[line],
        realtime: false,
        terminals: [stations[0].name, stations.at(-1).name],
        stationIds: canonical,
      },
    });
  }

  const stationFeatures = [...stationById.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .map((station) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: station.coordinates },
      properties: {
        type: 'station',
        mode: 'sbahn',
        id: `sb-${station.id}`,
        stop_id: station.id,
        apiId: station.apiId || null,
        name: station.name,
        lines: [...station.lines].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
        zone: 'Wien',
      },
    }));

  const usedServices = new Set(cityTrips.map((trip) => trip.service));
  const calendars = parseCsv(readZip('calendar.txt'))
    .filter((row) => usedServices.has(row.service_id))
    .map((row) => ({
      service: row.service_id,
      start: row.start_date,
      end: row.end_date,
      days: [row.monday, row.tuesday, row.wednesday, row.thursday, row.friday, row.saturday, row.sunday].map(Number),
    }));
  const exceptions = parseCsv(readZip('calendar_dates.txt'))
    .filter((row) => usedServices.has(row.service_id))
    .map((row) => [row.service_id, row.date, Number(row.exception_type)]);

  const output = {
    type: 'FeatureCollection',
    generatedAt: new Date().toISOString(),
    source: `ÖBB GTFS Fahrplan${selectedFeedYear ? ` ${selectedFeedYear}` : ''} (CC BY 4.0)`,
    features: [...lineFeatures, ...stationFeatures],
    schedule: {
      timezone: 'Europe/Vienna',
      calendars,
      exceptions,
      trips: cityTrips.map((trip) => [
        trip.id, trip.line, trip.service, trip.direction, trip.destination, trip.stops,
      ]),
    },
  };

  const target = path.join(projectRoot, 'src/data/sbahn_network.json');
  fs.writeFileSync(target, `${JSON.stringify(output)}\n`);
  console.log(`Wrote src/data/sbahn_network.json (${(fs.statSync(target).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`${lineFeatures.length} S-Bahn lines, ${stationFeatures.length} stations, ${cityTrips.length} scheduled trips`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

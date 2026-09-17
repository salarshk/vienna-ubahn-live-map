// External context feeds for the prediction layer.  Every source is optional:
// an outage, CORS failure or missing partnership credential must never take
// down the live rail map.  Public feeds are read directly; restricted feeds
// become active when their relay URL is supplied at build time.

const STORAGE_KEY = 'vienna_mobility_context_v1';
const REFRESH_MS = 10 * 60 * 1000;

const env = (key) => String(import.meta.env[key] || '').trim();

export const SOURCE_CATALOG = [
  { id: 'geosphere-nowcast', label: 'GeoSphere weather nowcast', kind: 'public', cadence: '15 min', models: 'weather-aware delay, dwell and crowding' },
  { id: 'geosphere-station', label: 'GeoSphere TAWES station', kind: 'public', cadence: '10 min', models: 'local weather calibration' },
  { id: 'air-quality', label: 'Vienna air-monitoring network', kind: 'public', cadence: 'hourly', models: 'outdoor comfort and demand context' },
  { id: 'holidays', label: 'Public and school holidays', kind: 'public', cadence: 'calendar', models: 'day-type demand baselines' },
  { id: 'wienmobil-rad', label: 'WienMobil Rad / Nextbike GBFS', kind: 'public', cadence: 'live', models: 'first/last-mile rescue' },
  { id: 'vienna-events', label: 'Vienna event database', kind: 'partner', cadence: 'event updates', models: 'event demand and station pressure' },
  { id: 'evis-traffic', label: 'EVIS / ITS Vienna Region', kind: 'partner', cadence: 'live/forecast', models: 'surface access and incident propagation' },
  { id: 'vao-routing', label: 'VAO multimodal routing', kind: 'partner', cadence: 'on demand', models: 'independent routing and connection validation' },
  { id: 'oebb-train-history', label: 'ÖBB train journeys and NeTEx', kind: 'archive', cadence: 'weekly/annual', models: 'S-Bahn delay labels and infrastructure joins' },
  { id: 'oebb-greenlight', label: 'ÖBB Greenlight / Aramis', kind: 'restricted', cadence: 'seconds', models: 'track-accurate S-Bahn position' },
  { id: 'passenger-counts', label: 'Operator passenger counts', kind: 'restricted', cadence: 'live/history', models: 'true occupancy and demand labels' },
  { id: 'vehicle-telemetry', label: 'Operator vehicle telemetry', kind: 'restricted', cadence: 'seconds', models: 'exact GPS, dwell and formation' },
  { id: 'mobile-movement', label: 'Aggregated mobile movement', kind: 'restricted', cadence: 'aggregated', models: 'citywide demand nowcast' },
];

const sourceTemplate = (catalog, extra = {}) => ({
  id: catalog.id,
  label: catalog.label,
  kind: catalog.kind,
  cadence: catalog.cadence,
  models: catalog.models,
  status: 'not connected',
  fetchedAt: null,
  error: null,
  ...extra,
});

const initialSources = () => Object.fromEntries(SOURCE_CATALOG.map((item) => [item.id, sourceTemplate(item)]));

const readCached = () => {
  try {
    if (typeof localStorage === 'undefined') return null;
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
};

const writeCached = (value) => {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* private mode */ }
};

const timeoutSignal = (ms = 9000) => (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
  ? AbortSignal.timeout(ms) : undefined;

const getJson = async (url) => {
  const response = await fetch(url, { signal: timeoutSignal(), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const status = (sources, id, next) => ({
  ...sources,
  [id]: {
    ...sources[id],
    ...next,
    fetchedAt: Object.prototype.hasOwnProperty.call(next, 'fetchedAt') ? next.fetchedAt : Date.now(),
  },
});

const number = (value) => {
  if (value == null || value === '' || Number(value) === -999) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};

const firstParameter = (parameters, names) => {
  for (const name of names) {
    const value = parameters?.[name];
    if (value == null) continue;
    const data = Array.isArray(value) ? value : Array.isArray(value.data) ? value.data : null;
    const latest = data?.at(-1);
    if (Number.isFinite(Number(latest))) return Number(latest);
  }
  return null;
};

export const parseGeoSphereNowcast = (payload) => {
  const feature = payload?.features?.[0];
  const parameters = feature?.properties?.parameters || {};
  const precipitation = firstParameter(parameters, ['rr', 'precipitation', 'RR']);
  const temperature = firstParameter(parameters, ['t2m', 'TL', 'temperature']);
  const wind = firstParameter(parameters, ['ff', 'wind', 'FF']);
  const values = (name) => {
    const item = parameters?.[name];
    return Array.isArray(item) ? item.map(number).filter(Number.isFinite) : Array.isArray(item?.data) ? item.data.map(number).filter(Number.isFinite) : [];
  };
  return {
    source: 'GeoSphere Austria INCA nowcast',
    temperature,
    precipitation,
    windSpeed: wind,
    next60MinPrecipitation: Math.max(0, ...values('rr'), ...values('precipitation')),
    forecastHours: Math.max(0, Number(payload?.features?.length ? 3 : 0)),
  };
};

export const parseAirQuality = (payload) => {
  const rows = Array.isArray(payload) ? payload
    : payload?.features?.map((feature) => feature.properties || feature) || payload?.data || payload?.results || payload?.airquality || [];
  const vienna = rows.filter((row) => /wien|vienna/i.test(JSON.stringify(row))).length ? rows.filter((row) => /wien|vienna/i.test(JSON.stringify(row))) : rows;
  const latest = vienna[0] || {};
  const read = (...keys) => keys.map((key) => latest[key]).find((value) => Number.isFinite(Number(value))) ?? null;
  return {
    source: 'City of Vienna air-monitoring network',
    stationCount: vienna.length,
    pm10: number(read('pm10', 'PM10', 'PM10_1h')),
    pm25: number(read('pm25', 'PM2.5', 'PM25', 'PM2_5')),
    no2: number(read('no2', 'NO2')),
    o3: number(read('o3', 'O3')),
    temperature: number(read('temperature', 'TEMP')),
    observedAt: latest.timestamp || latest.date || null,
  };
};

export const parseGbfs = (discovery, stationInformation, stationStatus) => {
  const info = stationInformation?.data?.stations || stationInformation?.stations || [];
  const live = stationStatus?.data?.stations || stationStatus?.stations || [];
  const byId = new Map(live.map((item) => [String(item.station_id), item]));
  const stations = info.map((item) => ({
    id: String(item.station_id), name: item.name, lat: number(item.lat), lon: number(item.lon), capacity: number(item.capacity),
    bikes: number(byId.get(String(item.station_id))?.num_bikes_available),
    docks: number(byId.get(String(item.station_id))?.num_docks_available),
  }));
  return { source: 'WienMobil Rad / Nextbike GBFS', stationCount: stations.length, availableBikes: stations.reduce((sum, item) => sum + (item.bikes || 0), 0), availableDocks: stations.reduce((sum, item) => sum + (item.docks || 0), 0), stations, discoveryUpdatedAt: discovery?.last_updated || null };
};

const dateIso = (date) => date.toISOString().slice(0, 10);

export const parseHolidays = (publicHolidays, schoolHolidays, now = Date.now()) => {
  const today = dateIso(new Date(now));
  const publicRows = Array.isArray(publicHolidays) ? publicHolidays : [];
  const schoolRows = Array.isArray(schoolHolidays) ? schoolHolidays : [];
  const contains = (row) => String(row?.startDate || row?.start || '').slice(0, 10) <= today
    && today <= String(row?.endDate || row?.end || row?.startDate || '').slice(0, 10);
  const currentPublic = publicRows.find(contains) || null;
  const currentSchool = schoolRows.find(contains) || null;
  const next = [...publicRows, ...schoolRows].map((row) => ({ ...row, date: String(row?.startDate || row?.start || '').slice(0, 10) }))
    .filter((row) => row.date > today).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
  return { source: 'OpenHolidays public and school calendars', isPublicHoliday: Boolean(currentPublic), isSchoolHoliday: Boolean(currentSchool), current: currentPublic || currentSchool, next: next ? { date: next.date, name: next.name || next.nameInLocale || 'Holiday' } : null };
};

const configuredSources = {
  'vienna-events': env('VITE_VIENNA_EVENTS_API_URL'),
  'evis-traffic': env('VITE_EVIS_API_URL'),
  'vao-routing': env('VITE_VAO_API_URL'),
  'oebb-train-history': env('VITE_OEBB_CONTEXT_API_URL'),
  'oebb-greenlight': env('VITE_OEBB_GREENLIGHT_API_URL'),
  'passenger-counts': env('VITE_PASSENGER_COUNT_API_URL'),
  'vehicle-telemetry': env('VITE_VEHICLE_TELEMETRY_API_URL'),
  'mobile-movement': env('VITE_MOBILE_MOVEMENT_API_URL'),
};

const cached = readCached();
let snapshot = cached?.sources ? cached : { status: 'idle', updatedAt: null, sources: initialSources(), context: {} };
let inFlight = null;
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener(snapshot));

const fetchPublic = async () => {
  let sources = { ...snapshot.sources, ...initialSources() };
  let context = { ...(snapshot.context || {}) };
  const nowcastUrl = 'https://dataset.api.hub.geosphere.at/v1/timeseries/forecast/nowcast-v1-15min-1km?parameters=t2m,rr,ff&lat_lon=48.2082,16.3738&forecast_offset=0&output_format=geojson';
  try {
    const payload = await getJson(nowcastUrl);
    context = { ...context, weatherNowcast: parseGeoSphereNowcast(payload) };
    sources = status(sources, 'geosphere-nowcast', { status: 'live', error: null });
  } catch (error) { sources = status(sources, 'geosphere-nowcast', { status: 'unavailable', error: error.message }); }

  try {
    const payload = await getJson('https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min?parameters=TL,RR,FF&station_ids=11035');
    context = { ...context, weatherStation: payload };
    sources = status(sources, 'geosphere-station', { status: 'live', error: null });
  } catch (error) { sources = status(sources, 'geosphere-station', { status: 'unavailable', error: error.message }); }

  try {
    const [publicHolidays, schoolHolidays] = await Promise.all([
      getJson(`https://openholidaysapi.org/PublicHolidays?countryIsoCode=AT&subdivisionCode=AT-9&languageIsoCode=EN&validFrom=${dateIso(new Date())}&validTo=${dateIso(new Date(Date.now() + 366 * 86400000))}`),
      getJson(`https://openholidaysapi.org/SchoolHolidays?countryIsoCode=AT&subdivisionCode=AT-9&languageIsoCode=EN&validFrom=${dateIso(new Date())}&validTo=${dateIso(new Date(Date.now() + 366 * 86400000))}`),
    ]);
    context = { ...context, holidays: parseHolidays(publicHolidays, schoolHolidays) };
    sources = status(sources, 'holidays', { status: 'live', error: null });
  } catch (error) { sources = status(sources, 'holidays', { status: 'unavailable', error: error.message }); }

  try {
    const discovery = await getJson('https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_wr/gbfs.json');
    const feeds = (discovery?.data?.feeds || discovery?.feeds || []);
    const findFeed = (type) => feeds.find((feed) => new RegExp(`station_${type}`, 'i').test(feed?.name || feed?.url || '') && /en|de/i.test(feed?.url || ''))?.url
      || feeds.find((feed) => new RegExp(`station_${type}`, 'i').test(feed?.name || feed?.url || ''))?.url;
    const [information, stationStatus] = await Promise.all([getJson(findFeed('information')), getJson(findFeed('status'))]);
    context = { ...context, bikeShare: parseGbfs(discovery, information, stationStatus) };
    sources = status(sources, 'wienmobil-rad', { status: 'live', error: null });
  } catch (error) { sources = status(sources, 'wienmobil-rad', { status: 'unavailable', error: error.message }); }

  try {
    const air = await getJson(env('VITE_AIR_QUALITY_API_URL') || 'https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0&typeName=ogdwien:LUFTGUETENETZOGD&srsName=EPSG:4326&outputFormat=json');
    context = { ...context, airQuality: parseAirQuality(air) };
    sources = status(sources, 'air-quality', { status: 'live', error: null });
  } catch (error) { sources = status(sources, 'air-quality', { status: 'unavailable', error: error.message }); }

  for (const item of SOURCE_CATALOG.filter((entry) => entry.kind !== 'public')) {
    const url = configuredSources[item.id];
    if (!url) {
      sources = status(sources, item.id, { status: item.kind === 'archive' ? 'available in repository/workflows' : 'awaiting access', fetchedAt: null, error: item.kind === 'archive' ? null : 'Requires a licensed relay or partner endpoint' });
      continue;
    }
    try {
      const value = await getJson(url);
      context = { ...context, [item.id]: value };
      sources = status(sources, item.id, { status: 'live', error: null });
    } catch (error) { sources = status(sources, item.id, { status: 'unavailable', error: error.message }); }
  }
  return { status: 'ready', updatedAt: Date.now(), sources, context };
};

export const fetchMobilityContext = async ({ force = false } = {}) => {
  if (!force && snapshot.updatedAt && Date.now() - snapshot.updatedAt < REFRESH_MS) return snapshot;
  if (inFlight) return inFlight;
  inFlight = fetchPublic().then((next) => {
    snapshot = next;
    writeCached(snapshot);
    notify();
    return snapshot;
  }).catch((error) => {
    snapshot = { ...snapshot, status: snapshot.updatedAt ? 'cached' : 'unavailable', error: error.message };
    notify();
    return snapshot;
  }).finally(() => { inFlight = null; });
  return inFlight;
};

export const mobilityContextStore = {
  getSnapshot: () => snapshot,
  subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  refresh: fetchMobilityContext,
  catalog: SOURCE_CATALOG,
};

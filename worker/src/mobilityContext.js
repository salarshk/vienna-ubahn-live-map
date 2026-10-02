// Shared city-context relay. Public counter locations are always available;
// measured traffic values, EVIS incidents and event records are opt-in Worker
// variables because their providers may require a contract or API key.

const COUNTER_WFS = 'https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0&typeName=ogdwien:DAUERZAEHLOGD&srsName=EPSG:4326&outputFormat=json';
const number = (...values) => values.map(Number).find(Number.isFinite) ?? null;
const boundedRows = (value, limit = 500) => {
  if (Array.isArray(value)) return value.slice(0, limit);
  if (Array.isArray(value?.features)) return value.features.slice(0, limit);
  if (Array.isArray(value?.data)) return value.data.slice(0, limit);
  if (Array.isArray(value?.results)) return value.results.slice(0, limit);
  if (Array.isArray(value?.items)) return value.items.slice(0, limit);
  return [];
};

export const parseCounterLocations = (payload) => {
  const locations = boundedRows(payload).map((feature) => {
    const properties = feature?.properties || feature || {};
    const coordinates = feature?.geometry?.coordinates;
    return {
      id: String(properties.ZST_ID || properties.ID || properties.id || properties.zst_id || ''),
      name: properties.ZST_NAME || properties.NAME || properties.name || 'Vienna traffic counter',
      road: properties.STRASSE || properties.ROAD || properties.road || null,
      lat: number(properties.lat, properties.latitude, properties.Y, coordinates?.[1]),
      lon: number(properties.lon, properties.longitude, properties.X, coordinates?.[0]),
    };
  }).filter((item) => item.id && Number.isFinite(item.lat) && Number.isFinite(item.lon));
  return { source: 'City of Vienna OGD traffic-counter locations', stationCount: locations.length, locations, valuesStatus: 'not connected' };
};

const fetchJson = async (url, fetchImpl) => {
  if (!url) return null;
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout?.(9000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

export const handleMobilityContext = async (request, env = {}, fetchImpl = fetch, origin = '') => {
  if (request.method !== 'GET' || !new URL(request.url).pathname.endsWith('/mobility-context')) return null;
  const generatedAt = Date.now();
  const sources = {};
  let counterLocations = { source: 'City of Vienna OGD traffic-counter locations', stationCount: 0, locations: [], valuesStatus: 'not connected' };
  try {
    counterLocations = parseCounterLocations(await fetchJson(COUNTER_WFS, fetchImpl));
    sources['vienna-traffic-counters'] = { status: 'live', fetchedAt: generatedAt, detail: `${counterLocations.stationCount} public counter locations` };
  } catch (error) {
    sources['vienna-traffic-counters'] = { status: 'unavailable', error: error.message };
  }

  const trafficUrl = env.VIENNA_TRAFFIC_API_URL || env.EVIS_TRAFFIC_API_URL;
  let traffic = { counterLocations, observations: [], status: 'catalog-only', valuesStatus: 'not connected', evidence: 'Public counter locations loaded; measured values feed is not configured' };
  if (trafficUrl) {
    try {
      const payload = await fetchJson(trafficUrl, fetchImpl);
      traffic = { counterLocations, observations: boundedRows(payload, 800), status: 'live', valuesStatus: 'live', evidence: 'Configured Vienna/EVIS traffic feed' };
      sources['evis-traffic'] = { status: 'live', fetchedAt: generatedAt };
    } catch (error) { sources['evis-traffic'] = { status: 'unavailable', error: error.message }; }
  } else sources['evis-traffic'] = { status: 'awaiting access', error: 'Set VIENNA_TRAFFIC_API_URL or EVIS_TRAFFIC_API_URL on the Worker for measured values' };

  let events = { records: [], active: [], status: 'not configured', evidence: 'Set VIENNA_EVENTS_API_URL for event records' };
  if (env.VIENNA_EVENTS_API_URL) {
    try {
      const payload = await fetchJson(env.VIENNA_EVENTS_API_URL, fetchImpl);
      const records = boundedRows(payload, 500);
      events = { records, active: records, status: 'live', evidence: 'Configured Vienna event feed' };
      sources['vienna-events'] = { status: 'live', fetchedAt: generatedAt };
    } catch (error) { sources['vienna-events'] = { status: 'unavailable', error: error.message }; }
  } else sources['vienna-events'] = { status: 'awaiting access' };

  return new Response(JSON.stringify({ schemaVersion: 1, generatedAt, source: 'vienna-mobility-context-relay', traffic, events, sources }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' } : {}),
      'Cache-Control': 'public, max-age=0, s-maxage=60',
    },
  });
};

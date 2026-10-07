// Public lift locations from the City of Vienna. Coordinates identify a lift,
// not a verified entrance-to-platform indoor route or its operating status.
const URL = 'https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0&typeName=ogdwien%3AAUFZUGOGD&srsName=EPSG%3A4326&outputFormat=json';
const CACHE_MS = 60 * 60 * 1000;
let cached = null;
let cachedAt = 0;
let inFlight = null;

export const parseLiftLocations = (payload) => (payload?.features || []).map((feature) => {
  const point = feature.geometry?.coordinates;
  const props = feature.properties || {};
  const coords = Array.isArray(point) && point.length >= 2
    ? (point[0] > 40 ? [Number(point[1]), Number(point[0])] : [Number(point[0]), Number(point[1])]) : null;
  return {
    id: String(feature.id || props.ID || ''),
    coordinates: coords,
    label: String(props.BEZEICHNUNG || props.NAME || props.STATION || props.STATIONSNAME || 'Mapped lift'),
  };
}).filter((item) => item.coordinates && item.coordinates[0] > 15 && item.coordinates[0] < 18 && item.coordinates[1] > 47 && item.coordinates[1] < 49);

export const getLiftLocations = async () => {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
  if (inFlight) return inFlight;
  inFlight = fetch(URL, { headers: { Accept: 'application/json' }, signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(12000) : undefined })
    .then((response) => { if (!response.ok) throw new Error(`Vienna lift locations HTTP ${response.status}`); return response.json(); })
    .then((payload) => { cached = parseLiftLocations(payload); cachedAt = Date.now(); return cached; })
    .finally(() => { inFlight = null; });
  return inFlight;
};

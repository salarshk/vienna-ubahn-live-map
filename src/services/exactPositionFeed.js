const configuredUrl = () => import.meta.env.VITE_OEBB_POSITION_URL || '';

export const normalisePositionPayload = (payload, fetchedAt = Date.now()) => {
  const records = Array.isArray(payload) ? payload : payload?.vehicles || payload?.trains || payload?.positions || [];
  return records.map((record) => {
    const coordinates = record.coordinates || (Number.isFinite(Number(record.lon)) && Number.isFinite(Number(record.lat))
      ? [Number(record.lon), Number(record.lat)] : null);
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    return {
      tripId: record.tripId || record.trip_id || record.id || null,
      line: record.line || record.routeShortName || 'S-Bahn',
      coordinates: [Number(coordinates[0]), Number(coordinates[1])],
      heading: Number.isFinite(Number(record.heading)) ? Number(record.heading) : null,
      observedAt: Number(record.observedAt || record.timestamp || fetchedAt),
      source: record.source || 'authorized-oebb-position-feed',
    };
  }).filter(Boolean);
};

export const getExactPositionSnapshot = async ({ signal } = {}) => {
  const url = configuredUrl();
  if (!url) return { status: 'unavailable', reason: 'No authorized exact-position feed configured', positions: [], fetchedAt: null, source: 'none' };
  const fetchedAt = Date.now();
  try {
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Feed returned ${response.status}`);
    return { status: 'live', reason: null, positions: normalisePositionPayload(await response.json(), fetchedAt), fetchedAt, source: url };
  } catch (error) {
    return { status: 'error', reason: error.message || 'Exact-position feed unavailable', positions: [], fetchedAt, source: url };
  }
};

export const exactPositionConfigured = () => Boolean(configuredUrl());
export default getExactPositionSnapshot;

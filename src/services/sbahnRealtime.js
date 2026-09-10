const configuredUrl = () => import.meta.env.VITE_OEBB_REALTIME_URL || '';

const normaliseRecord = (record = {}, fetchedAt = Date.now()) => {
  const delay = Number(record.delaySeconds ?? record.delay ?? record.delay_sec);
  return {
    tripId: record.tripId || record.trip_id || record.id || null,
    line: record.line || record.routeShortName || record.route_short_name || 'S-Bahn',
    destination: record.destination || record.headsign || record.trip_headsign || '',
    delaySeconds: Number.isFinite(delay) ? delay : null,
    status: record.status || (record.cancelled ? 'cancelled' : 'scheduled'),
    cancelled: Boolean(record.cancelled || record.status === 'cancelled'),
    platform: record.platform || record.platformName || null,
    observedAt: Number(record.observedAt || record.timestamp || fetchedAt),
    source: record.source || 'authorized-oebb-realtime-feed',
  };
};

export const normaliseSbahnPayload = (payload, fetchedAt = Date.now()) => {
  const records = Array.isArray(payload) ? payload : payload?.records || payload?.trips || payload?.vehicles || [];
  return records.map((record) => normaliseRecord(record, fetchedAt)).filter((record) => record.tripId || record.line);
};

export const getSbahnRealtimeSnapshot = async ({ signal } = {}) => {
  const url = configuredUrl();
  if (!url) return { status: 'unavailable', reason: 'No authorized ÖBB live feed configured', records: [], fetchedAt: null, source: 'none' };
  const fetchedAt = Date.now();
  try {
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Feed returned ${response.status}`);
    const payload = await response.json();
    return { status: 'live', reason: null, records: normaliseSbahnPayload(payload, fetchedAt), fetchedAt, source: url };
  } catch (error) {
    return { status: 'error', reason: error.message || 'S-Bahn live feed unavailable', records: [], fetchedAt, source: url };
  }
};

export const sbahnRealtimeConfigured = () => Boolean(configuredUrl());
export default getSbahnRealtimeSnapshot;

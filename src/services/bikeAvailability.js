import { RAIL_HISTORY_URL } from './sharedRailHistory';

const BIKE_HISTORY_URL = String(import.meta.env.VITE_BIKE_HISTORY_API_URL || (RAIL_HISTORY_URL ? RAIL_HISTORY_URL.replace(/\/rail-history(?:\?.*)?$/, '/bike-history') : '')).trim();
const cache = new Map();

export const fetchBikeHistory = async (ids = []) => {
  if (!BIKE_HISTORY_URL || !ids.length) return { status: 'not configured', samples: [] };
  const url = new URL(BIKE_HISTORY_URL);
  url.searchParams.set('ids', [...new Set(ids.map(String))].sort().join(','));
  const key = url.toString();
  const old = cache.get(key);
  if (old && Date.now() - old.at < 60000) return old.value;
  const response = await fetch(key, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Bike history HTTP ${response.status}`);
  const value = await response.json();
  cache.set(key, { at: Date.now(), value });
  return value;
};

export const forecastBikeStock = (history, stationId, arrivalAt = Date.now() + 15 * 60000, now = Date.now()) => {
  const samples = (history?.samples || []).map((sample) => ({ at: Number(sample.at), station: sample.stations.find((station) => station.id === String(stationId)) }))
    .filter((item) => item.station && Number.isFinite(item.station.bikes) && item.at <= now)
    .sort((a, b) => a.at - b.at);
  const latest = samples.at(-1);
  if (!latest || now - latest.at > 15 * 60000) return null;
  const recent = samples.filter((item) => item.at >= latest.at - 60 * 60000);
  if (recent.length < 4 || recent.at(-1).at - recent[0].at < 20 * 60000) return {
    bikesNow: latest.station.bikes, expectedBikes: null, samples: recent.length, status: 'collecting',
  };
  const first = recent.slice(0, Math.min(3, recent.length));
  const last = recent.slice(-Math.min(3, recent.length));
  const average = (rows) => rows.reduce((sum, row) => sum + row.station.bikes, 0) / rows.length;
  const elapsedMinutes = Math.max(1, (last.at(-1).at - first[0].at) / 60000);
  const changePerMinute = (average(last) - average(first)) / elapsedMinutes;
  const horizonMinutes = Math.max(0, Math.min(30, (arrivalAt - now) / 60000));
  const expectedBikes = Math.max(0, Math.min(latest.station.capacity || Infinity, Math.round(latest.station.bikes + changePerMinute * horizonMinutes)));
  return { bikesNow: latest.station.bikes, expectedBikes, samples: recent.length, horizonMinutes: Math.round(horizonMinutes), status: 'trend estimate' };
};

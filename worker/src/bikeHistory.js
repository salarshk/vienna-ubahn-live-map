const KEY = 'rail-history/bikes/latest.json';
const GBFS = 'https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_wr/gbfs.json';
const RETENTION_MS = 75 * 60 * 1000;
const STALE_MS = 15 * 60 * 1000;

const datedKey = (at) => {
  const iso = new Date(at).toISOString();
  return `vienna-rail/bike-snapshots/${iso.slice(0, 10)}/${iso.slice(11, 16).replace(':', '-')}.json`;
};

const getJson = async (url, fetchImpl) => {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout?.(9000) });
  if (!response.ok) throw new Error(`GBFS HTTP ${response.status}`);
  return response.json();
};

export const parseBikeSnapshot = (information, status, at = Date.now()) => {
  const info = information?.data?.stations || information?.stations || [];
  const live = status?.data?.stations || status?.stations || [];
  const byId = new Map(live.map((row) => [String(row.station_id), row]));
  return {
    at,
    stations: info.map((row) => ({
      id: String(row.station_id), name: String(row.name || 'Bike station'),
      lat: Number(row.lat), lon: Number(row.lon), capacity: Number(row.capacity) || null,
      bikes: Number(byId.get(String(row.station_id))?.num_bikes_available),
      docks: Number(byId.get(String(row.station_id))?.num_docks_available),
    })).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon) && Number.isFinite(row.bikes)),
  };
};

export const collectBikeHistory = async (env, fetchImpl = fetch) => {
  if (!env?.RAIL_ARCHIVE?.get || !env?.RAIL_ARCHIVE?.put) return null;
  const discovery = await getJson(GBFS, fetchImpl);
  // GBFS v2 auto-discovery commonly groups feeds by language (data.en.feeds).
  const feeds = discovery?.data?.en?.feeds || discovery?.data?.de?.feeds
    || discovery?.data?.feeds || discovery?.feeds || [];
  const feed = (name) => feeds.find((row) => row.name === `station_${name}`)?.url;
  const infoUrl = feed('information');
  const statusUrl = feed('status');
  if (!infoUrl || !statusUrl) throw new Error('GBFS station feeds were not advertised');
  const [information, status, previousObject] = await Promise.all([
    getJson(infoUrl, fetchImpl), getJson(statusUrl, fetchImpl), env.RAIL_ARCHIVE.get(KEY),
  ]);
  const previous = previousObject ? await previousObject.json().catch(() => null) : null;
  const sample = parseBikeSnapshot(information, status);
  if (!sample.stations.length) throw new Error('GBFS returned no usable bike stations');
  const samples = [...(previous?.samples || []), sample].filter((row) => row.at >= sample.at - RETENTION_MS);
  const next = { version: 2, updatedAt: sample.at, cadenceSeconds: 300, source: 'WienMobil Rad / Nextbike GBFS', samples };
  // Keep every dated observation even after it ages out of the small public
  // trend window. The latest cursor is committed only after archival succeeds.
  await env.RAIL_ARCHIVE.put(datedKey(sample.at), JSON.stringify(sample), { httpMetadata: { contentType: 'application/json' } });
  await env.RAIL_ARCHIVE.put(KEY, JSON.stringify(next), { httpMetadata: { contentType: 'application/json' } });
  return next;
};

export const handleBikeHistory = async (request, env, origin) => {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Cache-Control': 'public, max-age=0, s-maxage=60' };
  if (!env?.RAIL_ARCHIVE?.get) return new Response(JSON.stringify({ status: 'not configured', samples: [] }), { status: 503, headers });
  const object = await env.RAIL_ARCHIVE.get(KEY);
  if (!object) return new Response(JSON.stringify({ status: 'collecting', samples: [] }), { headers });
  const payload = await object.json();
  const ids = new Set(String(new URL(request.url).searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 10));
  const samples = (payload.samples || []).map((sample) => ({
    at: sample.at, stations: ids.size ? sample.stations.filter((station) => ids.has(station.id)) : [],
  })).filter((sample) => sample.stations.length);
  const archiveAgeSeconds = Math.max(0, Math.round((Date.now() - payload.updatedAt) / 1000));
  return new Response(JSON.stringify({ status: archiveAgeSeconds > STALE_MS / 1000 ? 'stale' : 'ready', source: payload.source, updatedAt: payload.updatedAt, archiveAgeSeconds, cadenceSeconds: payload.cadenceSeconds, samples }), { headers });
};

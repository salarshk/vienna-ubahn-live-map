import { describe, expect, it, vi } from 'vitest';
import { handleRailHistory, summariseRailSample, updateRailHistory } from './railHistory';
import { collectBikeHistory, handleBikeHistory, parseBikeSnapshot } from './bikeHistory';

const bucket = () => {
  const objects = new Map();
  return {
    objects,
    get: vi.fn(async (key) => objects.has(key) ? { json: async () => JSON.parse(objects.get(key)), text: async () => objects.get(key) } : null),
    put: vi.fn(async (key, value) => { objects.set(key, value); }),
  };
};
const observation = (at, realtimeTimestamp = at + 300000) => ({
  stationId: 60201320, stationName: 'Stephansplatz', line: 'U1', direction: 'Leopoldau',
  destination: 'Leopoldau', plannedTimestamp: at + 180000, realtimeTimestamp,
  reportedDelaySeconds: Math.round((realtimeTimestamp - (at + 180000)) / 1000),
});

describe('shared rail history', () => {
  it('compares the same planned departure across samples and persists one minute once', async () => {
    const at = Math.floor(Date.now() / 300000) * 300000 + 60000;
    const store = bucket();
    const first = { generatedAt: at, sourceServerTime: String(at), observations: [observation(at)], completeness: { complete: true } };
    const second = { ...first, generatedAt: at + 60000, sourceServerTime: String(at + 60000), observations: [observation(at, at + 420000)] };
    await updateRailHistory({ RAIL_ARCHIVE: store }, first);
    await updateRailHistory({ RAIL_ARCHIVE: store }, second);
    await updateRailHistory({ RAIL_ARCHIVE: store }, second);
    const latest = JSON.parse(store.objects.get('rail-history/latest.json'));
    expect(latest.samples).toHaveLength(2);
    expect(latest.samples[1].rows[0]).toMatchObject({ etaPairs: 1, etaStablePairs: 0, maxEtaRevisionSeconds: 120 });
    expect(store.put).toHaveBeenCalledTimes(4);
    const response = await handleRailHistory(new Request('https://worker.example/rail-history?station=Stephansplatz&days=1'), { RAIL_ARCHIVE: store }, 'https://salarshk.github.io');
    const payload = await response.json();
    expect(payload.recent).toHaveLength(2);
    expect(payload.hourly[0].etaPairs).toBe(1);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://salarshk.github.io');
  });

  it('never labels unpaired predictions as stability evidence', () => {
    const at = Date.now();
    expect(summariseRailSample({ generatedAt: at, observations: [observation(at)] }).sample.rows[0].etaPairs).toBe(0);
  });

  it('exports filtered CSV without leaking unselected stations', async () => {
    const store = bucket();
    const at = Date.now();
    await updateRailHistory({ RAIL_ARCHIVE: store }, { generatedAt: at, observations: [observation(at), { ...observation(at), stationId: 42, stationName: 'Karlsplatz' }] });
    const response = await handleRailHistory(new Request('https://worker.example/rail-history?station=Stephansplatz&days=1&format=csv'), { RAIL_ARCHIVE: store }, 'https://salarshk.github.io');
    const csv = await response.text();
    expect(csv).toContain('Stephansplatz');
    expect(csv).not.toContain('Karlsplatz');
  });
});

describe('shared bike history', () => {
  it('joins GBFS information to live stock', () => {
    expect(parseBikeSnapshot({ data: { stations: [{ station_id: '1', name: 'Ring', lat: 48.21, lon: 16.37, capacity: 20 }] } }, { data: { stations: [{ station_id: '1', num_bikes_available: 5, num_docks_available: 15 }] } }).stations[0]).toMatchObject({ id: '1', bikes: 5, docks: 15 });
  });

  it('collects and exposes only requested station IDs', async () => {
    const store = bucket();
    const fetchImpl = vi.fn(async (url) => new Response(JSON.stringify(String(url).endsWith('gbfs.json')
      ? { data: { en: { feeds: [{ name: 'station_information', url: 'https://bikes.test/info' }, { name: 'station_status', url: 'https://bikes.test/status' }] } } }
      : String(url).endsWith('/info')
        ? { data: { stations: [{ station_id: '1', name: 'Ring', lat: 48.21, lon: 16.37 }, { station_id: '2', name: 'Park', lat: 48.2, lon: 16.3 }] } }
        : { data: { stations: [{ station_id: '1', num_bikes_available: 5 }, { station_id: '2', num_bikes_available: 4 }] } }), { status: 200 }));
    await collectBikeHistory({ RAIL_ARCHIVE: store }, fetchImpl);
    const response = await handleBikeHistory(new Request('https://worker.example/bike-history?ids=1'), { RAIL_ARCHIVE: store }, 'https://salarshk.github.io');
    const payload = await response.json();
    expect(payload.samples[0].stations.map((row) => row.id)).toEqual(['1']);
  });
});

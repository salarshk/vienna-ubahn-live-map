import { afterEach, describe, it, expect, vi } from 'vitest';
import { arrivalStore, STATION_ID_MAP } from './arrivalStore';

describe('Vienna U-Bahn station identifiers', () => {
  it('resolves central interchanges to Wiener Linien DIVA ids', () => {
    expect(STATION_ID_MAP.Stephansplatz).toBe(60201320);
    expect(STATION_ID_MAP.Karlsplatz).toBe(60200657);
    expect(STATION_ID_MAP.Westbahnhof).toBe(60201468);
  });

  it('provides a live endpoint id for every tested interchange', () => {
    for (const name of ['Stephansplatz', 'Karlsplatz', 'Westbahnhof']) {
      expect(arrivalStore.getStationApiId({ name })).not.toBeNull();
    }
  });
});

describe('batched live synchronization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    arrivalStore.memory.clear();
    arrivalStore.lastRequestTimestamp = 0;
  });

  it('requests multiple DIVA stations at once and stores their live departures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          monitors: [{
            locationStop: { properties: { name: '60201320' } },
            lines: [{
              name: 'U1',
              towards: 'Leopoldau',
              direction: 'H',
              realtimeSupported: true,
              departures: {
                departure: [{
                  departureTime: {
                    timeReal: '2026-09-09T18:10:00.000+0200',
                    countdown: 2,
                  },
                  vehicle: { name: 'U1', towards: 'Leopoldau', direction: 'H' },
                }],
              },
            }],
          }],
        },
      }),
    }));

    const updated = await arrivalStore.fetchStationBatch([
      { id: 60201320, name: 'Stephansplatz' },
      { id: 60201182, name: 'Schottenring' },
    ]);

    expect(fetch).toHaveBeenCalledOnce();
    const requestedUrl = fetch.mock.calls[0][0];
    expect(requestedUrl).toContain('diva=60201320');
    expect(requestedUrl).toContain('diva=60201182');
    expect(updated).toBe(1);
    const [arrival] = arrivalStore.memory.get('60201320').arrivals;
    expect(arrival.isLive).toBe(true);
    expect(arrival.directionCode).toBe('H');
    expect(arrival.plannedTargetTimestamp).toBeTypeOf('number');
  });
});

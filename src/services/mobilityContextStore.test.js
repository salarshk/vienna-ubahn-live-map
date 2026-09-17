import { describe, expect, it } from 'vitest';
import {
  parseAirQuality,
  parseGbfs,
  parseGeoSphereNowcast,
  parseHolidays,
} from './mobilityContextStore';

describe('mobility context parsers', () => {
  it('extracts weather values from a GeoSphere GeoJSON nowcast', () => {
    const result = parseGeoSphereNowcast({
      features: [{ properties: { parameters: {
        t2m: { data: [18.2, 18.4] },
        rr: { data: [0.2, 1.4] },
        ff: { data: [3.1, 4.2] },
      } } }],
    });
    expect(result).toMatchObject({ temperature: 18.4, precipitation: 1.4, windSpeed: 4.2, next60MinPrecipitation: 1.4 });
  });

  it('selects Vienna air-quality measurements and ignores non-numeric fields', () => {
    const result = parseAirQuality({ features: [{ properties: { station: 'Wien Stephansplatz', pm10: '17.5', pm25: '8', no2: '21', o3: '44', timestamp: '2026-09-17T10:00:00Z' } },
      { station: 'Graz', pm10: '99' },
    ] });
    expect(result).toMatchObject({ stationCount: 1, pm10: 17.5, pm25: 8, no2: 21, o3: 44 });
  });

  it('joins GBFS station metadata with live bike and dock counts', () => {
    const result = parseGbfs({}, {
      data: { stations: [{ station_id: '1', name: 'Karlsplatz', lat: '48.2', lon: '16.37', capacity: '20' }] },
    }, {
      data: { stations: [{ station_id: '1', num_bikes_available: 7, num_docks_available: 13 }] },
    });
    expect(result).toMatchObject({ stationCount: 1, availableBikes: 7, availableDocks: 13 });
    expect(result.stations[0]).toMatchObject({ id: '1', bikes: 7, docks: 13, capacity: 20 });
  });

  it('identifies current and next public or school holidays', () => {
    const result = parseHolidays([
      { startDate: '2026-09-16', endDate: '2026-09-18', name: 'Public holiday' },
    ], [
      { startDate: '2026-10-26', endDate: '2026-10-31', name: 'Autumn break' },
    ], new Date('2026-09-17T12:00:00Z').getTime());
    expect(result).toMatchObject({ isPublicHoliday: true, isSchoolHoliday: false, next: { date: '2026-10-26' } });
  });
});

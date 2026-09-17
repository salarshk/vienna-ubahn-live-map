import { describe, expect, it } from 'vitest';
import { buildDataDrivenModels, DATA_MODEL_CATALOG } from './dataDrivenModels';

describe('new-data model suite', () => {
  it('returns every catalogue model with a transparent output', () => {
    const models = buildDataDrivenModels({
      now: new Date('2026-09-17T08:00:00Z').getTime(),
      context: {
        weatherNowcast: { next60MinPrecipitation: 1.2, windSpeed: 8 },
        holidays: { isSchoolHoliday: false, isPublicHoliday: false },
        airQuality: { pm10: 18, no2: 24 },
        bikeShare: { availableBikes: 30, availableDocks: 20 },
      },
      sources: {
        'geosphere-nowcast': { status: 'live' },
        holidays: { status: 'live' },
        'air-quality': { status: 'live' },
        'wienmobil-rad': { status: 'live' },
      },
      arrivals: [{ line: 'U1', reportedDelaySeconds: 180 }],
      issues: [{ line: 'U1', type: 'gap', station: 'Karlsplatz' }],
      disruptions: [{ lines: ['U1'], title: 'Signal issue' }],
      crowding: [{ line: 'U1', score: 60 }],
      vehicles: [{ id: 'u1-1', line: 'U1', lastDataAgeSeconds: 2 }],
    });
    expect(models).toHaveLength(DATA_MODEL_CATALOG.length);
    expect(models.every((item) => item.name && item.output && item.status)).toBe(true);
    expect(models.find((item) => item.id === 'weather-delay').status).toBe('live');
    expect(models.find((item) => item.id === 'control-room-decisions').decisions).toHaveLength(5);
  });

  it('does not pretend restricted partner feeds are connected', () => {
    const models = buildDataDrivenModels();
    expect(models.find((item) => item.id === 'mobility-flow').status).toBe('baseline');
    expect(models.find((item) => item.id === 'fleet-formation').status).toBe('baseline');
  });
});


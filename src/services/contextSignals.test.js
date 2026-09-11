import { describe, expect, it } from 'vitest';
import { normaliseWeather } from './contextSignals';

describe('context signals', () => {
  it('normalises the keyless Vienna weather payload for prediction models', () => {
    const weather = normaliseWeather({ current: {
      temperature_2m: 21.4,
      precipitation: 1.2,
      rain: 1.2,
      showers: 0,
      snowfall: 0,
      wind_speed_10m: 42,
      weather_code: 63,
    } }, 1234);
    expect(weather).toMatchObject({ temperature: 21.4, precipitation: 1.2, windSpeed: 42, description: 'rain', fetchedAt: 1234 });
  });
});


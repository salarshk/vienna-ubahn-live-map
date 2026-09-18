import { describe, expect, it } from 'vitest';
import {
  buildMultimodalFallbacks,
  estimateEnvironmentalComfort,
  parseAirportActivity,
  parseEventContext,
  parseTrafficContext,
  predictAirportArrivalWave,
  predictEventCrowding,
  predictTrafficAwareTrams,
} from './transportIntelligence';

describe('transport intelligence', () => {
  it('normalises road observations and raises tram exposure', () => {
    const context = { 'evis-traffic': { data: [{ speed: 9, delay: 6, event: 'roadwork' }, { speed: 12, congested: true }] } };
    const traffic = parseTrafficContext(context);
    expect(traffic).toMatchObject({ observations: 2, incidents: 1, status: 'observed' });
    const [tram] = predictTrafficAwareTrams({ tramPredictions: [{ line: 'D', pressure: 40 }], context, issues: [] });
    expect(tram.risk).toBeGreaterThan(25);
  });

  it('distinguishes explicit airport arrivals from inferred aircraft activity', () => {
    const explicit = parseAirportActivity({ 'airport-flights': { arrivals: [{ flight: 'OS1' }, { flight: 'LH2' }], departures: [{ flight: 'OS3' }] } });
    expect(predictAirportArrivalWave({ context: { 'airport-flights': { arrivals: [{ flight: 'OS1' }], departures: [] } } })).toMatchObject({ arrivals: 1, confidence: 72 });
    expect(explicit.activity).toBe(3);
    const inferred = parseAirportActivity({ opensky: { states: [{ baro_altitude: 1800, on_ground: false }] } });
    expect(inferred).toMatchObject({ approaching: 1, confidence: 44 });
  });

  it('builds event pressure, environmental comfort and multimodal options', () => {
    const context = {
      'vienna-events': { data: [{ name: 'Concert', expectedAttendance: 8000 }] },
      weatherNowcast: { next60MinPrecipitation: 3, windSpeed: 8, temperature: 2 },
      airQuality: { pm10: 32, no2: 28 },
      bikeShare: { availableBikes: 40, availableDocks: 12 },
    };
    expect(parseEventContext(context).events).toBe(1);
    expect(predictEventCrowding({ context }).score).toBeGreaterThan(20);
    expect(estimateEnvironmentalComfort({ context }).level).toBe('poor');
    expect(buildMultimodalFallbacks({ context, lineRisk: 70 })[0].mode).toBe('bike');
  });
});

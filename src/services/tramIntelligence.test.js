import { describe, expect, it } from 'vitest';
import { buildTramPredictions, summariseTramPredictions, TRAM_LINES } from './tramIntelligence';

describe('tram intelligence', () => {
  it('covers the generated tram network without mixing U-Bahn lines', () => {
    expect(TRAM_LINES.length).toBeGreaterThan(25);
    expect(TRAM_LINES.every((line) => !line.startsWith('U'))).toBe(true);
  });

  it('produces separate pressure, impact and headway outputs for trams', () => {
    const predictions = buildTramPredictions({
      now: 1000,
      arrivals: [
        { line: 'D', stationName: 'Schottentor', seconds: 120, isLive: true, reportedDelaySeconds: 180 },
        { line: 'D', stationName: 'Schottentor', seconds: 240, isLive: true, reportedDelaySeconds: 120 },
      ],
      vehicles: [{ line: 'D', isLive: true }],
      disruptions: [{ lines: ['D'] }],
      issues: [{ line: 'D', type: 'gap' }],
    });
    const d = predictions.find((item) => item.line === 'D');
    expect(d).toMatchObject({ mode: 'tram', liveArrivals: 2, liveVehicles: 1, impactLevel: 'high' });
    expect(d.headway.largestGapMinutes).toBe(2);
    expect(summariseTramPredictions(predictions).liveLines).toBe(1);
  });
});

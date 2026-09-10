import { describe, expect, it } from 'vitest';
import {
  buildCalendarPressure, buildDataQuality, buildEtaUncertainty,
  buildRecoveryForecast, buildRouteRisk, simulateNetworkScenario,
} from './advancedIntelligence';

describe('advanced network intelligence', () => {
  it('turns position uncertainty into an ETA range', () => {
    const vehicle = {
      id: 'u1-test', line: 'U1', isLive: true, secondsToTarget: 240,
      positionUncertaintyMetres: 300, positionConfidence: 74, destination: 'Leopoldau', targetStation: 'Praterstern',
    };
    const result = buildEtaUncertainty([vehicle]);
    expect(result[0]).toMatchObject({ line: 'U1', eta: 4, low: 0, high: 8, confidence: 74 });
    expect(buildEtaUncertainty([{ ...vehicle, positionConfidence: 0.45 }])[0].confidence).toBe(45);
  });

  it('estimates recovery only when there is an observed signal', () => {
    const result = buildRecoveryForecast({
      issues: [{ line: 'U4', type: 'gap', severity: 360 }],
      forecasts: [{ minutes: 10, lines: [{ line: 'U4', risk: 80 }] }],
      reliability: [],
    });
    expect(result.find((item) => item.line === 'U4').status).toBe('watch');
    expect(result.find((item) => item.line === 'U1').status).toBe('stable');
  });

  it('labels calendar pressure without claiming occupancy', () => {
    const result = buildCalendarPressure(new Date('2026-09-14T08:00:00').getTime(), [{ line: 'U2', level: 'medium' }]);
    expect(result[0].outlook).toBe('Elevated next 60 min');
    expect(result[0].source).toContain('weekday peak');
  });

  it('reports feed quality and scenario sensitivity', () => {
    const now = Date.now();
    const quality = buildDataQuality({
      now, entries: [{ fetchedAt: now, arrivals: [{ isLive: true }] }],
      vehicles: [{ isLive: true }], sbahnFreshness: { status: 'fresh' },
    });
    expect(quality).toMatchObject({ freshStations: 1, liveArrivals: 1, liveVehicles: 1, sbahn: 'fresh' });
    const scenario = simulateNetworkScenario({ line: 'U1', extraMinutes: 15, issues: [], forecasts: [{ minutes: 10, lines: [{ line: 'U1', risk: 50 }] }] });
    expect(scenario[0].risk).toBeGreaterThan(0);
    expect(buildRouteRisk({ recovery: [{ line: 'U1', status: 'watch' }], pressure: [{ line: 'U1', level: 'high' }], reliability: [] })[0])
      .toMatchObject({ line: 'U1', level: 'high' });
  });
});

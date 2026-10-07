import { describe, expect, it } from 'vitest';
import { buildDelayOnsets, estimatedArrivalByChance, stationDelayWindowsFromHistory } from './sharedRailHistory';
import { forecastBikeStock } from './bikeAvailability';
import { buildEventExodus, buildRoadworkImpacts } from './partnerImpactModels';
import { estimateDirectUbahnTravel } from './arrivalByPlanner';

describe('new passenger and reliability features', () => {
  it('withholds a numerical arrival chance until revision evidence exists', () => {
    const input = { departureAt: 100000, travelSeconds: 600, deadlineAt: 100000 + 900000, meanEtaRevisionSeconds: 30 };
    expect(estimatedArrivalByChance({ ...input, etaPairs: 29 }).chance).toBeNull();
    expect(estimatedArrivalByChance({ ...input, etaPairs: 30 }).chance).toBeGreaterThan(50);
  });

  it('aggregates station delay windows and detects a direction-specific rise', () => {
    const now = Date.now();
    const row = (delay) => ({ stationName: 'Stephansplatz', line: 'U1', direction: 'Leopoldau', observations: 4, labelledObservations: 4, delaySumSeconds: delay * 4, etaPairs: 2, etaStablePairs: 1 });
    const history = { recent: [{ at: now - 45 * 60000, rows: [row(30)] }, { at: now - 10 * 60000, rows: [row(150)] }] };
    expect(stationDelayWindowsFromHistory(history, 'Stephansplatz', ['U1'], now).find((window) => window.id === '60m').lines[0].meanDelaySeconds).toBe(90);
    expect(buildDelayOnsets(history, now)[0].riseSeconds).toBe(120);
  });

  it('estimates bike stock only with a fresh trend', () => {
    const now = Date.now();
    const history = { samples: [40, 30, 20, 10, 0].map((minutesAgo, index) => ({ at: now - minutesAgo * 60000, stations: [{ id: '1', bikes: 8 - index, capacity: 20 }] })) };
    expect(forecastBikeStock(history, '1', now + 15 * 60000, now).expectedBikes).toBeLessThan(4);
  });

  it('does not invent roadworks or events when partner feeds are disconnected', () => {
    expect(buildRoadworkImpacts({ valuesStatus: 'not connected' }).impacts).toEqual([]);
    expect(buildEventExodus({ status: 'not configured' }).events).toEqual([]);
  });

  it('uses mapped direct U-Bahn geometry, not a fabricated cross-line route', () => {
    expect(estimateDirectUbahnTravel('Karlsplatz', 'Stephansplatz', 'U1')?.seconds).toBeGreaterThan(0);
    expect(estimateDirectUbahnTravel('Karlsplatz', 'Stephansplatz', 'U6')).toBeNull();
  });
});

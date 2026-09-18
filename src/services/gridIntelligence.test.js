import { describe, expect, it } from 'vitest';
import { buildCellIntelligence, coordinatesToCell, cellsToGeoJSON, GRID_SIZE_METRES } from './gridIntelligence';

describe('50 metre cell intelligence', () => {
  it('uses stable metric cells for nearby coordinates', () => {
    const first = coordinatesToCell([16.3738, 48.2082]);
    const second = coordinatesToCell([16.3748, 48.2082]);
    expect(first.id).not.toBe(second.id);
    expect(first.bounds[2] - first.bounds[0]).toBeCloseTo(GRID_SIZE_METRES / (111320 * Math.cos(48.2082 * Math.PI / 180)), 8);
  });

  it('combines train, delay, gap and disruption signals into ranked cells', () => {
    const result = buildCellIntelligence({
      now: 1_700_000_000_000,
      vehicles: [{ id: 'u1-1', line: 'U1', coordinates: [16.3738, 48.2082], isLive: true, exactGpsAvailable: true, officialDelaySeconds: 240 }],
      entries: [{ stationName: 'Stephansplatz', fetchedAt: 1_700_000_000_000, arrivals: [{ line: 'U1', isLive: true, reportedDelaySeconds: 180, delayTrendMinutes: 1.2 }] }],
      issues: [{ type: 'gap', line: 'U1', station: 'Stephansplatz', seconds: 900 }],
      disruptions: [{ station: 'Stephansplatz', isElevator: true }],
    });
    expect(result.cells.length).toBeGreaterThan(0);
    expect(result.rankings.delay[0].meanDelaySeconds).toBeGreaterThan(0);
    expect(result.rankings.access[0].accessibilityIssues).toBe(1);
    expect(cellsToGeoJSON(result.cells, true).features.length).toBe(result.cells.length);
    expect(cellsToGeoJSON(result.cells, false).features).toHaveLength(0);
  });
});

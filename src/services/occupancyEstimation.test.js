import { describe, expect, it } from 'vitest';
import { estimateOccupancy } from './occupancyEstimation';

describe('occupancy estimation', () => {
  it('raises the proxy for peak service issues and reports', () => {
    const result = estimateOccupancy({
      line: 'U1', now: new Date('2026-09-10T07:30:00').getTime(),
      crowding: [{ line: 'U1', score: 50, level: 'medium' }],
      issues: [{ line: 'U1', type: 'gap' }],
      reports: [{ line: 'U1', severity: 'high', category: 'crowding' }],
    });
    expect(result.score).toBeGreaterThan(50);
    expect(result.level).toMatch(/high|very-high/);
    expect(result.source).toContain('public departures');
  });
});

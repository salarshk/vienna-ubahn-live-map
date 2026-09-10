import { describe, expect, it } from 'vitest';
import { estimateCrowdingRisk, forecastDelayPropagation } from './transitModels';

describe('experimental transit models', () => {
  it('decays a disruption seed while allowing later interchange spillover', () => {
    const forecasts = forecastDelayPropagation([
      { type: 'gap', line: 'U1', severity: 120 },
    ], []);
    expect(forecasts[0].lines[0]).toMatchObject({ line: 'U1' });
    expect(forecasts[0].lines.some((item) => item.line === 'U4')).toBe(false);
    expect(forecasts[1].lines.some((item) => item.line === 'U4')).toBe(true);
    expect(forecasts[2].lines.find((item) => item.line === 'U1').risk)
      .toBeLessThan(forecasts[0].lines.find((item) => item.line === 'U1').risk);
  });

  it('labels a line with a large service gap as high pressure', () => {
    const mondayPeak = new Date('2026-09-14T08:00:00');
    const risks = estimateCrowdingRisk([{ type: 'gap', line: 'U6' }], mondayPeak);
    expect(risks.find((item) => item.line === 'U6').level).toBe('high');
  });
});

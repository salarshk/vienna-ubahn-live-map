import { describe, expect, it } from 'vitest';
import {
  featureVector, incidentContextForLine, predictFinalDelay, predictOnlineDelay,
} from './delayModel';

const arrival = {
  line: 'U1', directionCode: 'H', trafficJam: false,
  activeIncidentCount: 1, incidentPriority: 2, delayRelatedIncident: true,
  plannedTargetTimestamp: Date.UTC(2026, 8, 10, 8, 0),
  targetTimestamp: Date.UTC(2026, 8, 10, 8, 2),
};

describe('delay model runtime', () => {
  it('builds the same 17 features as the trainer', () => {
    const vector = featureVector(arrival, Date.UTC(2026, 8, 10, 7, 54));
    expect(vector).toHaveLength(17);
    expect(vector[1]).toBe(2);
    expect(vector[2]).toBe(8);
    expect(vector.slice(9, 12)).toEqual([1, 2, 1]);
    expect(vector.slice(-5)).toEqual([1, 0, 0, 0, 0]);
  });

  it('applies stored scaling and clamps the result', () => {
    const model = {
      status: 'ready',
      deployed: true,
      weights: Array(17).fill(0),
      scaling: Array.from({ length: 17 }, () => ({ mean: 0, scale: 1 })),
      predictionRangeMinutes: [-2, 30],
    };
    model.weights[0] = 40;
    expect(predictFinalDelay(model, arrival)).toBe(30);
  });

  it('builds active incident context for a line', () => {
    const now = Date.parse('2026-09-10T10:00:00Z');
    expect(incidentContextForLine([{
      lines: ['U1'], title: 'Signalstörung mit Verspätungen', priority: 2,
      startsAt: '2026-09-10T09:00:00Z', endsAt: '2026-09-10T11:00:00Z',
    }, {
      lines: ['U1'], title: 'Past incident', priority: 3,
      endsAt: '2026-09-10T08:00:00Z',
    }], 'U1', now)).toEqual({
      activeIncidentCount: 1, incidentPriority: 2, delayRelatedIncident: true,
    });
  });

  it('applies a ready online calibration without replacing the batch model', () => {
    const model = {
      onlineCalibration: {
        status: 'ready', deployed: true, predictionRangeMinutes: [-2, 30],
        state: {
          global: { count: 24, sum: 24 },
          lines: { U1: { count: 12, sum: 12 } },
          contexts: { incident: { count: 10, sum: 10 } },
        },
      },
    };
    expect(predictOnlineDelay(model, arrival)).toBe(3.5);
  });
});

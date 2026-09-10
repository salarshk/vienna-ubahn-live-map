import { describe, expect, it } from 'vitest';
import { featureVector, predictFinalDelay } from './delayModel';

const arrival = {
  line: 'U1', directionCode: 'H', trafficJam: false,
  plannedTargetTimestamp: Date.UTC(2026, 8, 10, 8, 0),
  targetTimestamp: Date.UTC(2026, 8, 10, 8, 2),
};

describe('delay model runtime', () => {
  it('builds the same 14 features as the trainer', () => {
    const vector = featureVector(arrival, Date.UTC(2026, 8, 10, 7, 54));
    expect(vector).toHaveLength(14);
    expect(vector[1]).toBe(2);
    expect(vector[2]).toBe(8);
    expect(vector.slice(-5)).toEqual([1, 0, 0, 0, 0]);
  });

  it('applies stored scaling and clamps the result', () => {
    const model = {
      status: 'ready',
      deployed: true,
      weights: Array(14).fill(0),
      scaling: Array.from({ length: 14 }, () => ({ mean: 0, scale: 1 })),
      predictionRangeMinutes: [-2, 30],
    };
    model.weights[0] = 40;
    expect(predictFinalDelay(model, arrival)).toBe(30);
  });
});

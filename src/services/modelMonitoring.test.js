import { describe, expect, it } from 'vitest';
import { assessModelHealth } from './modelMonitoring';

describe('model monitoring', () => {
  it('rolls back a candidate that does not beat the baseline', () => {
    const health = assessModelHealth({
      model: { status: 'ready', deployed: false, trainedAt: Date.now() },
      metrics: { model: { maeMinutes: 4, rmseMinutes: 6, sampleCount: 200 }, deployment: { deployed: false } },
    });
    expect(health.status).toBe('rollback');
    expect(health.rollback).toBe(true);
    expect(health.reasons.join(' ')).toContain('baseline');
  });
});

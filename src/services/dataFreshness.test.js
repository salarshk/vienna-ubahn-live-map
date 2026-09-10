import { describe, expect, it } from 'vitest';
import { formatGtfsDate, getSbahnFreshness, isSbahnScheduleUsable } from './dataFreshness';

describe('S-Bahn data freshness', () => {
  it('reports the bundled timetable validity in a readable form', () => {
    expect(formatGtfsDate('20261212')).toBe('12 Dec 2026');
    expect(getSbahnFreshness(new Date('2026-09-10T12:00:00Z'))).toMatchObject({
      status: 'fresh',
      validUntil: '20261212',
    });
  });

  it('warns during the final 30 days', () => {
    expect(getSbahnFreshness(new Date('2026-12-01T12:00:00Z')).status).toBe('expiring');
  });

  it('withdraws an expired timetable', () => {
    expect(getSbahnFreshness(new Date('2026-12-14T12:00:00Z')).status).toBe('expired');
    expect(isSbahnScheduleUsable(new Date('2026-12-14T12:00:00Z'))).toBe(false);
  });
});


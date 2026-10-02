import { describe, expect, it } from 'vitest';
import { buildUrbanMobilityForecast, parseUrbanEvents, parseUrbanTraffic } from './urbanMobilityModels';

describe('urban mobility models', () => {
  it('scores observed traffic and incident signals', () => {
    expect(parseUrbanTraffic({ urbanTraffic: { observations: [{ speed: 8, congested: true, event: 'roadwork' }, { speed: 20 }] } })).toMatchObject({ observations: 2, incidents: 1, congestedSegments: 1, status: 'observed' });
  });

  it('keeps active event records and attendance as an explicit signal', () => {
    const result = parseUrbanEvents({ urbanEvents: { records: [{ title: 'Concert', attendance: 10000, lat: 48.2, lon: 16.3 }] } }, Date.parse('2026-09-17T12:00:00Z'));
    expect(result).toMatchObject({ total: 1, active: 1, expectedAttendance: 10000 });
  });

  it('returns three horizons and a clear baseline limitation when feeds are absent', () => {
    const result = buildUrbanMobilityForecast({ now: Date.parse('2026-09-17T12:00:00Z') });
    expect(result.horizons.map((item) => item.minutes)).toEqual([15, 30, 60]);
    expect(result.status).toBe('baseline');
    expect(result.limitations).toContain('measured speed');
  });
});

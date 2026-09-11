import { describe, expect, it } from 'vitest';
import { detectHeadwayEvents, reconcileHeadwayEvents } from './headway_events.mjs';

describe('headway event archive', () => {
  it('detects a station-level gap with explicit GPS provenance', () => {
    const observedAt = Date.parse('2026-09-11T10:00:00Z');
    const events = detectHeadwayEvents([
      { stationId: 1, stationName: 'Karlsplatz', line: 'U1', direction: 'H', vehicleId: 'a', realTime: '2026-09-11T10:01:00Z' },
      { stationId: 1, stationName: 'Karlsplatz', line: 'U1', direction: 'H', vehicleId: 'b', realTime: '2026-09-11T10:10:00Z' },
    ], observedAt);
    expect(events[0]).toMatchObject({ type: 'gap', station: 'Karlsplatz', intervalSeconds: 540, exactGpsAvailable: false });
  });

  it('keeps an event active, then records recovery duration', () => {
    const start = 1_800_000_000_000;
    const event = { eventId: 'gap|1|U1|H', type: 'gap', line: 'U1', station: 'Testplatz', intervalSeconds: 500 };
    const first = reconcileHeadwayEvents({ current: [event], observedAt: start });
    const second = reconcileHeadwayEvents({ current: [event], state: first.state, observedAt: start + 5 * 60 * 1000 });
    const recovered = reconcileHeadwayEvents({ current: [], state: second.state, observedAt: start + 15 * 60 * 1000 });
    expect(recovered.observations.at(-1)).toMatchObject({ eventStatus: 'recovered', recoveryDurationSeconds: 900 });
  });
});

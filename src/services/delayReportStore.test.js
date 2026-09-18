import { describe, expect, it } from 'vitest';
import delayReportStore, { buildDelayRankings } from './delayReportStore';

const entries = [
  { stationName: 'Karlsplatz', arrivals: [
    { line: 'U1', vehicleId: 'u1-101', destination: 'Oberlaa', directionCode: 'H', isLive: true, reportedDelaySeconds: 300, plannedTargetTimestamp: 1 },
    { line: 'U1', vehicleId: 'u1-102', destination: 'Oberlaa', directionCode: 'H', isLive: true, reportedDelaySeconds: 60, plannedTargetTimestamp: 2 },
  ] },
  { stationName: 'Stephansplatz', arrivals: [
    { line: 'U3', vehicleId: 'u3-201', destination: 'Simmering', directionCode: 'H', isLive: true, reportedDelaySeconds: 120, plannedTargetTimestamp: 3 },
  ] },
];

describe('delay report store', () => {
  it('ranks current trains, stations and lines by observed delay', () => {
    const rankings = buildDelayRankings(entries, 1000);
    expect(rankings.trains[0]).toMatchObject({ vehicleId: 'u1-101', meanDelaySeconds: 300, station: 'Karlsplatz' });
    expect(rankings.stations[0]).toMatchObject({ station: 'Karlsplatz', meanDelaySeconds: 180 });
    expect(rankings.lines[0]).toMatchObject({ line: 'U1', meanDelaySeconds: 180 });
  });

  it('keeps compact hourly through yearly aggregates', () => {
    delayReportStore.clear();
    const first = Date.UTC(2026, 8, 18, 10, 0, 0);
    expect(delayReportStore.record(entries, first)).toBe(true);
    expect(delayReportStore.record(entries, first + 60 * 1000)).toBe(true);
    expect(delayReportStore.getReport('hourly', first + 2 * 60 * 1000).lines[0]).toMatchObject({ id: 'U1', samples: 4, meanDelaySeconds: 180 });
    expect(delayReportStore.getSnapshot().buckets).toMatchObject({ hourly: 1, daily: 1, weekly: 1, monthly: 1, yearly: 1 });
    delayReportStore.clear();
  });
});

import { describe, expect, it } from 'vitest';
import sbahnData from '../data/sbahn_network.json';
import {
  getScheduledSbahnVehicles,
  getScheduledSbahnArrivals,
  getViennaServiceClock,
  SBAHN_LINES,
} from './sbahnSchedule';

describe('Vienna S-Bahn timetable', () => {
  it('contains all ten current S-Bahn services', () => {
    expect(SBAHN_LINES).toEqual(['S1', 'S2', 'S3', 'S4', 'S7', 'S40', 'S45', 'S50', 'S60', 'S80']);
  });

  it('keeps every mapped line connected to at least two stations', () => {
    for (const line of SBAHN_LINES) {
      const feature = sbahnData.features.find((item) => item.properties.line === line);
      expect(feature.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('uses Vienna local time rather than the viewer timezone', () => {
    expect(getViennaServiceClock(new Date('2026-09-10T09:15:30Z')))
      .toMatchObject({ date: '20260910', seconds: 11 * 3600 + 15 * 60 + 30 });
  });

  it('positions the S-Bahn trips actually running at that instant', () => {
    const vehicles = getScheduledSbahnVehicles(new Date('2026-09-10T09:15:30Z'));
    expect(vehicles.length).toBeGreaterThan(10);
    expect(new Set(vehicles.map((vehicle) => vehicle.line)).size).toBeGreaterThanOrEqual(7);
    expect(vehicles.every((vehicle) =>
      SBAHN_LINES.includes(vehicle.line) && vehicle.isScheduled && !vehicle.isLive &&
      vehicle.coordinates.every(Number.isFinite)
    )).toBe(true);
  });

  it('provides scheduled departures for S-Bahn station panels', () => {
    const arrivals = getScheduledSbahnArrivals(
      { name: 'Hütteldorf', apiId: 60200560, lines: ['S45', 'S50', 'S80'] },
      new Date('2026-09-10T09:15:30Z')
    );
    expect(arrivals.length).toBeGreaterThan(0);
    expect(arrivals.every((arrival) => arrival.line.startsWith('S') && arrival.isScheduled))
      .toBe(true);
  });
});

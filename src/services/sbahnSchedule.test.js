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

  it('uses the official Vienna S-Bahn route-family colours', () => {
    const colours = Object.fromEntries(SBAHN_LINES.map((line) => [
      line,
      sbahnData.features.find((item) => item.properties.line === line).properties.color,
    ]));
    expect(colours).toEqual({
      S1: '#CB7375', S2: '#CB7375', S3: '#CB7375', S4: '#CB7375',
      S7: '#20214F', S40: '#20214F', S45: '#8AAE1F',
      S50: '#20214F', S60: '#20214F', S80: '#20214F',
    });
  });

  it('draws the S7 corridor through the airport and Fischamend', () => {
    const stationNames = new Map(
      sbahnData.features
        .filter((item) => item.geometry.type === 'Point')
        .map((item) => [item.properties.stop_id, item.properties.name])
    );
    const s7 = sbahnData.features.find((item) => item.geometry.type === 'LineString' && item.properties.line === 'S7');
    const names = s7.properties.stationIds.map((id) => stationNames.get(id));
    expect(names.indexOf('Flughafen Wien')).toBeGreaterThan(-1);
    expect(names.indexOf('Fischamend')).toBeGreaterThan(names.indexOf('Flughafen Wien'));
    expect(s7.geometry.coordinates.length).toBe(names.length);
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
    expect(vehicles.every((vehicle) =>
      vehicle.positionSource === 'scheduled-timetable'
      && vehicle.dataFreshness === 'timetable-only'
      && vehicle.lastDataAt === null
      && vehicle.lastDataAgeSeconds === null
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

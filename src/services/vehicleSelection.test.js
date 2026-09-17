import { describe, expect, it } from 'vitest';
import { findVehicleForArrival } from './vehicleSelection';

describe('station departure vehicle selection', () => {
  it('prefers the matching live vehicle at the tapped station', () => {
    const vehicles = [
      {
        id: 'live-u1-near', line: 'U1', direction: 'Leopoldau', isLive: true,
        sourceStationName: 'Stephansplatz', secondsToSourceStation: 120,
      },
      {
        id: 'live-u1-far', line: 'U1', direction: 'Leopoldau', isLive: true,
        sourceStationName: 'Karlsplatz', secondsToSourceStation: 90,
      },
    ];

    expect(findVehicleForArrival(
      vehicles,
      { line: 'U1', destination: 'Leopoldau', seconds: 118 },
      'Stephansplatz',
    )?.id).toBe('live-u1-near');
  });

  it('uses the official vehicle number when one is available', () => {
    const vehicles = [
      { id: 'live-u1-21', line: 'U1', vehicleId: '21', direction: 'Oberlaa', isLive: true },
      { id: 'live-u1-22', line: 'U1', vehicleId: '22', direction: 'Oberlaa', isLive: true },
    ];

    expect(findVehicleForArrival(
      vehicles,
      { line: 'U1', destination: 'Oberlaa', vehicleId: '22' },
      'Karlsplatz',
    )?.id).toBe('live-u1-22');
  });

  it('matches scheduled S-Bahn departures by trip id', () => {
    const vehicles = [
      { id: 'scheduled-trip-7-20260917', tripId: 'trip-7', line: 'S7', direction: 'Wolfsthal', isScheduled: true },
    ];

    expect(findVehicleForArrival(
      vehicles,
      { line: 'S7', destination: 'Wolfsthal', tripId: 'trip-7' },
      'Wien Mitte',
    )?.id).toBe('scheduled-trip-7-20260917');
  });

  it('returns null when no route identity matches', () => {
    expect(findVehicleForArrival(
      [{ id: 'live-u2', line: 'U2', direction: 'Seestadt', isLive: true }],
      { line: 'U1', destination: 'Leopoldau' },
      'Karlsplatz',
    )).toBeNull();
  });
});

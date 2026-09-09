import { beforeEach, describe, expect, it } from 'vitest';
import arrivalStore from './arrivalStore';
import { getStationFocus } from './stationFocus';

const STEPHANSPLATZ = { apiId: 60201320, name: 'Stephansplatz', lines: ['U1', 'U3'] };
const LEOPOLDAU = { apiId: 60200769, name: 'Leopoldau', lines: ['U1'] };

const remember = (station, arrivals, now, fetchedAt = now) => {
  arrivalStore.memory.set(String(station.apiId), {
    stationId: station.apiId,
    stationName: station.name,
    fetchedAt,
    arrivals: arrivals.map((arrival) => ({
      line: arrival.line,
      destination: arrival.destination,
      vehicleId: arrival.vehicleId ?? null,
      lineColor: '#888',
      lineName: arrival.line,
      targetTimestamp: now + arrival.inSeconds * 1000,
      isLive: true,
    })),
  });
};

describe('Vienna station focus', () => {
  beforeEach(() => arrivalStore.memory.clear());

  it('splits a through station into both travel directions', () => {
    const now = Date.now();
    remember(STEPHANSPLATZ, [
      { line: 'U1', destination: 'Leopoldau', inSeconds: 120 },
      { line: 'U1', destination: 'Oberlaa', inSeconds: 300 },
    ], now);

    const focus = getStationFocus(STEPHANSPLATZ, now);
    expect(focus.directions).toHaveLength(2);
    expect(focus.directions.map((direction) => direction.label))
      .toEqual(expect.arrayContaining(['Leopoldau', 'Oberlaa']));
  });

  it('gives a terminus one direction', () => {
    const now = Date.now();
    remember(LEOPOLDAU, [
      { line: 'U1', destination: 'Oberlaa', inSeconds: 90 },
      { line: 'U1', destination: 'Oberlaa', inSeconds: 480 },
    ], now);

    const focus = getStationFocus(LEOPOLDAU, now);
    expect(focus.directions).toHaveLength(1);
    expect(focus.directions[0].label).toBe('Oberlaa');
    expect(focus.directions[0].arrivals).toHaveLength(2);
  });

  it('points direction arms along the line geometry', () => {
    const now = Date.now();
    remember(STEPHANSPLATZ, [
      { line: 'U1', destination: 'Leopoldau', inSeconds: 120 },
      { line: 'U1', destination: 'Oberlaa', inSeconds: 300 },
    ], now);

    const directions = getStationFocus(STEPHANSPLATZ, now).directions;
    expect(directions).toHaveLength(2);
    for (const direction of directions) {
      expect(direction.bearing).toBeGreaterThanOrEqual(0);
      expect(direction.bearing).toBeLessThan(360);
    }
  });

  it('sorts arrivals and each direction by countdown', () => {
    const now = Date.now();
    remember(STEPHANSPLATZ, [
      { line: 'U1', destination: 'Leopoldau', inSeconds: 600 },
      { line: 'U1', destination: 'Leopoldau', inSeconds: 120 },
      { line: 'U3', destination: 'Simmering', inSeconds: 340 },
    ], now);

    const focus = getStationFocus(STEPHANSPLATZ, now);
    expect(focus.arrivals.map((arrival) => arrival.seconds)).toEqual([120, 340, 600]);
    for (const direction of focus.directions) {
      const seconds = direction.arrivals.map((arrival) => arrival.seconds);
      expect(seconds).toEqual([...seconds].sort((a, b) => a - b));
    }
  });

  it('distinguishes a fresh API answer from an older memory countdown', () => {
    const now = Date.now();
    remember(STEPHANSPLATZ, [
      { line: 'U1', destination: 'Leopoldau', inSeconds: 300 },
    ], now);
    expect(getStationFocus(STEPHANSPLATZ, now).isFresh).toBe(true);

    remember(STEPHANSPLATZ, [
      { line: 'U1', destination: 'Leopoldau', inSeconds: 300 },
    ], now, now - 180000);
    const stale = getStationFocus(STEPHANSPLATZ, now);
    expect(stale.isFresh).toBe(false);
    expect(stale.secondsUnheard).toBe(180);
  });

  it('does not repeat each direction headline in later arrivals', () => {
    const now = Date.now();
    remember(STEPHANSPLATZ, [
      { line: 'U1', destination: 'Leopoldau', inSeconds: 120 },
      { line: 'U1', destination: 'Leopoldau', inSeconds: 600 },
      { line: 'U1', destination: 'Oberlaa', inSeconds: 240 },
    ], now);

    const focus = getStationFocus(STEPHANSPLATZ, now);
    expect(focus.directions).toHaveLength(2);
    expect(focus.laterArrivals).toHaveLength(1);
    expect(focus.laterArrivals[0].seconds).toBe(600);
  });

  it('handles a station with no cached predictions', () => {
    const focus = getStationFocus(STEPHANSPLATZ, Date.now());
    expect(focus.arrivals).toEqual([]);
    expect(focus.directions).toEqual([]);
    expect(focus.isFresh).toBe(false);
  });
});

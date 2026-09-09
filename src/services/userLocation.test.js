import { describe, it, expect } from 'vitest';
import {
  locate,
  findNearestStation,
  NEAREST_STATION_RANGE_M,
  MAX_USABLE_ACCURACY_M,
} from './userLocation';

// Real coordinates from gtfs_expanded.json. Using the actual data rather than a
// fixture network is the point: the gates are calibrated against this network's
// real station spacing, so a synthetic one would test nothing.
const STEPHANSPLATZ = [16.3716344, 48.2081338];
const KARLSPLATZ = [16.3689484, 48.2009554];
// Roughly 90 m north of Karlsplatz.
const NEAR_KARLSPLATZ = [16.3689484, 48.2017554];
const OFF_NETWORK = [16.8, 48.5];

const fix = (coordinates, accuracy = 12) => ({
  coords: {
    longitude: coordinates[0],
    latitude: coordinates[1],
    accuracy,
  },
});

// Stands in for @capacitor/geolocation. `granted` by default, because the
// permission paths are exercised by their own cases below.
const fakeProvider = ({
  permission = 'granted',
  requested = 'granted',
  position = fix(NEAR_KARLSPLATZ),
  error = null,
  checkThrows = null,
  hang = false,
} = {}) => ({
  checkPermissions: async () => {
    if (checkThrows) throw checkThrows;
    return { location: permission };
  },
  requestPermissions: async () => ({ location: requested }),
  getCurrentPosition: async () => {
    if (hang) return new Promise(() => {});
    if (error) throw error;
    return position;
  },
});

const geolocationError = (code, message) => {
  const err = new Error(message);
  err.code = code;
  return err;
};

describe('findNearestStation', () => {
  it('returns the Station itself when standing on it', () => {
    const nearest = findNearestStation(STEPHANSPLATZ);
    expect(nearest.station.properties.name).toBe('Stephansplatz');
    expect(nearest.distance).toBeLessThan(1);
  });

  it('picks the closest Station to a point between Stations', () => {
    const nearest = findNearestStation(NEAR_KARLSPLATZ);
    expect(nearest.station.properties.name).toBe('Karlsplatz');
    expect(nearest.distance).toBeLessThan(120);
  });

  it('stays policy-free: it names the nearest Station however far away it is', () => {
    // The 2 km cutoff is locate()'s business, not this function's. Keeping the
    // search honest means the caller can say *how* far off the network you are.
    const nearest = findNearestStation(OFF_NETWORK);
    expect(nearest.station).toBeTruthy();
    expect(nearest.distance).toBeGreaterThan(NEAREST_STATION_RANGE_M);
  });

  it('returns the same feature object the map and search hand around', () => {
    // App.jsx passes whatever it is given straight to StationPanel, which reads
    // `.properties`, so a bare {name, coords} object would break the panel.
    const { station } = findNearestStation(KARLSPLATZ);
    expect(station.geometry.type).toBe('Point');
    expect(station.properties.lines).toContain('U4');
  });
});

describe('locate', () => {
  it('names the Nearest Station for a good fix near the network', async () => {
    const result = await locate({ provider: fakeProvider() });

    expect(result.status).toBe('located');
    expect(result.coordinates).toEqual(NEAR_KARLSPLATZ);
    expect(result.accuracy).toBe(12);
    expect(result.nearestStation.properties.name).toBe('Karlsplatz');
    expect(result.distance).toBeLessThan(120);
    expect(result.reason).toBeNull();
  });

  it('locates but names no Station when the network is out of range', async () => {
    const result = await locate({
      provider: fakeProvider({ position: fix(OFF_NETWORK) }),
    });

    expect(result.status).toBe('located');
    expect(result.coordinates).toEqual(OFF_NETWORK);
    expect(result.nearestStation).toBeNull();
    expect(result.reason).toBe('out-of-range');
    expect(result.message).toMatch(/not near any metro station/i);
  });

  it('locates but names no Station when the fix is too rough to choose one', async () => {
    // Standing right on Benimaclet, but with a cell-tower fix. Half the gap to
    // the next Station is under 200 m network-wide, so a 900 m fix picks at
    // random — naming one would dress a coin flip up as an answer.
    const result = await locate({
      provider: fakeProvider({ position: fix(KARLSPLATZ, 900) }),
    });

    expect(result.status).toBe('located');
    expect(result.nearestStation).toBeNull();
    expect(result.reason).toBe('imprecise');
    expect(result.accuracy).toBe(900);
  });

  it('accepts a fix right at the accuracy limit', async () => {
    const result = await locate({
      provider: fakeProvider({ position: fix(NEAR_KARLSPLATZ, MAX_USABLE_ACCURACY_M) }),
    });

    expect(result.nearestStation.properties.name).toBe('Karlsplatz');
    expect(result.reason).toBeNull();
  });

  it('reports a denied permission without prompting again', async () => {
    let prompted = false;
    const provider = fakeProvider({ permission: 'denied' });
    provider.requestPermissions = async () => {
      prompted = true;
      return { location: 'denied' };
    };

    const result = await locate({ provider });

    // iOS will not re-prompt after a hard denial; asking again just burns a
    // round trip and returns the same answer.
    expect(prompted).toBe(false);
    expect(result.status).toBe('denied');
    expect(result.message).toMatch(/settings/i);
  });

  it('prompts once when permission has not been asked for yet', async () => {
    const result = await locate({
      provider: fakeProvider({ permission: 'prompt', requested: 'granted' }),
    });

    expect(result.status).toBe('located');
  });

  it('reports a denial made at the prompt', async () => {
    const result = await locate({
      provider: fakeProvider({ permission: 'prompt', requested: 'denied' }),
    });

    expect(result.status).toBe('denied');
  });

  it('reports location services being off as unavailable, not denied', async () => {
    // The plugin throws from checkPermissions when system location services are
    // disabled. That is a different fix from "allow this app", so it gets a
    // different sentence.
    const result = await locate({
      provider: fakeProvider({ checkThrows: new Error('Location services are not enabled') }),
    });

    expect(result.status).toBe('unavailable');
    expect(result.message).toMatch(/location services/i);
  });

  it('maps the browser error codes onto the four statuses', async () => {
    const denied = await locate({
      provider: fakeProvider({ error: geolocationError(1, 'User denied Geolocation') }),
    });
    const unavailable = await locate({
      provider: fakeProvider({ error: geolocationError(2, 'Position unavailable') }),
    });
    const timedOut = await locate({
      provider: fakeProvider({ error: geolocationError(3, 'Timeout expired') }),
    });

    expect(denied.status).toBe('denied');
    expect(unavailable.status).toBe('unavailable');
    expect(timedOut.status).toBe('timeout');
  });

  it('classifies a native error by its message when it carries no code', async () => {
    // CoreLocation errors arrive through the bridge as plain messages.
    const result = await locate({
      provider: fakeProvider({ error: new Error('User denied location permission') }),
    });

    expect(result.status).toBe('denied');
  });

  // The plugin's web implementation has no requestPermissions at all — it
  // throws UNIMPLEMENTED — because in a browser it is getCurrentPosition itself
  // that raises the permission prompt. Treating that throw as a failure would
  // mean the very first press never works in Chrome, which is where all the
  // testing happens.
  const capacitorException = (code, message) => {
    const err = new Error(message);
    err.code = code;
    return err;
  };

  it('still gets a fix when the platform has no requestPermissions', async () => {
    const provider = fakeProvider({ permission: 'prompt' });
    provider.requestPermissions = async () => {
      throw capacitorException('UNIMPLEMENTED', 'Not implemented on web.');
    };

    const result = await locate({ provider });

    expect(result.status).toBe('located');
    expect(result.nearestStation.properties.name).toBe('Karlsplatz');
  });

  it('still gets a fix when the browser has no Permissions API', async () => {
    const provider = fakeProvider({
      checkThrows: capacitorException('UNAVAILABLE', 'Permissions API not available in this browser'),
    });

    const result = await locate({ provider });

    expect(result.status).toBe('located');
  });

  it('reports the browser prompt being refused when there is no permissions API', async () => {
    // With no way to ask up front, the refusal only shows up as the error
    // getCurrentPosition rejects with.
    const provider = fakeProvider({ permission: 'prompt' });
    provider.requestPermissions = async () => {
      throw capacitorException('UNIMPLEMENTED', 'Not implemented on web.');
    };
    provider.getCurrentPosition = async () => {
      throw geolocationError(1, 'User denied Geolocation');
    };

    const result = await locate({ provider });

    expect(result.status).toBe('denied');
  });

  it('gives up on a fix that never arrives', async () => {
    // The plugin takes a timeout of its own, but a hung bridge call would leave
    // the button spinning forever, so locate() holds its own stopwatch too.
    const result = await locate({
      provider: fakeProvider({ hang: true }),
      timeoutMs: 20,
    });

    expect(result.status).toBe('timeout');
  });

  it('always says something a person can read', async () => {
    const results = await Promise.all([
      locate({ provider: fakeProvider() }),
      locate({ provider: fakeProvider({ permission: 'denied' }) }),
      locate({ provider: fakeProvider({ error: geolocationError(2, 'nope') }) }),
      locate({ provider: fakeProvider({ hang: true }), timeoutMs: 20 }),
    ]);

    for (const result of results) {
      expect(typeof result.message).toBe('string');
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

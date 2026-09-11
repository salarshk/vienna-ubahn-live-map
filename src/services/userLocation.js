// User Location
//
// The one module that talks to the device's location. Everything the locate
// button needs comes back from a single `locate()` call: the fix, how much to
// trust it, the Nearest Station if there is one worth naming, and a sentence
// explaining any of the four ways this ends without one.
//
// The provider is an argument rather than an import so the failure paths — a
// denial, services switched off, a fix that never arrives — are testable
// without a browser or a phone. See ADR-0004 for why the provider is the
// Capacitor plugin on native targets, with `navigator.geolocation` as the
// fallback for an installed browser PWA.
import { Geolocation } from '@capacitor/geolocation';
import metroData from '../data/metro_lines.json';
import gtfsData from '../data/gtfs_expanded.json';
import sbahnData from '../data/sbahn_network.json';
import { getDistance } from '../utils/geoUtils';

// Beyond this, there is no Nearest Station worth naming — only a far one. Set
// at walking distance rather than anything the network implies: the question
// the button answers is "which platform do I walk to", and 2 km is already
// twenty-five minutes of walking.
export const NEAREST_STATION_RANGE_M = 2000;

// A fix rougher than this cannot choose between neighbouring Stations, so it is
// not allowed to try. Nearest-neighbour spacing on this network is 632 m at the
// median and 387 m at the first quartile, which puts half the gap between
// neighbours under 200 m in the dense parts of the city. A ±500 m fix standing
// between two Stations picks by coin flip; naming the winner would present that
// flip as an answer. The map still centres on the fix — being located is useful
// even when it cannot pick a platform for you.
export const MAX_USABLE_ACCURACY_M = 500;

// How long before a fix is declared lost. The plugin takes a timeout of its own
// and honours it on both targets, but a hung bridge call would never reject at
// all, and a button spinning forever is worse than one that says it failed.
export const FIX_TIMEOUT_MS = 10000;

// A fix this fresh is reused rather than re-acquired, so pressing the button
// twice in quick succession is instant instead of waiting on the GPS again.
export const FIX_MAX_AGE_MS = 30000;

// Mirrors the station set MapView draws (MapView.jsx). gtfs_expanded.json
// carries every Station on the network, so it is the single source here;
// metro_lines.json only contributes points it alone knows about.
const gtfsStations = (gtfsData && gtfsData.features)
  ? gtfsData.features.filter((f) => f.geometry.type === 'Point')
  : [];
const gtfsStationNames = new Set(gtfsStations.map((f) => f.properties.name));
export const STATIONS = [
  ...gtfsStations,
  ...sbahnData.features.filter((f) => f.geometry.type === 'Point'),
  ...metroData.features.filter(
    (f) => f.geometry.type === 'Point' && !gtfsStationNames.has(f.properties.name)
  ),
];

/**
 * The Station lying the smallest straight-line distance from a coordinate.
 * Straight-line rather than along the network, because you walk to a Station
 * rather than ride to it.
 *
 * Deliberately policy-free: it names the nearest Station however far away that
 * is, and leaves `locate()` to decide whether the answer is worth showing. That
 * split is what lets the caller say how far off the network you actually are.
 *
 * @param {[number, number]} coordinates [lon, lat]
 * @returns {{station: object, distance: number} | null}
 */
export const findNearestStation = (coordinates) => {
  let best = null;

  for (const station of STATIONS) {
    const distance = getDistance(coordinates, station.geometry.coordinates);
    if (!best || distance < best.distance) best = { station, distance };
  }

  return best;
};

const MESSAGES = {
  denied: 'Location is off for this app. Turn it on in Settings to find your nearest station.',
  unavailable: 'Location services are unavailable on this device right now.',
  timeout: 'Could not get a location fix. Try again somewhere with a clearer view of the sky.',
  imprecise: 'Your location is too rough to pick a station from.',
  'out-of-range': 'You are not near any metro station on this network.',
};

const failure = (status) => ({
  status,
  coordinates: null,
  accuracy: null,
  fetchedAt: null,
  nearestStation: null,
  distance: null,
  reason: null,
  source: 'device-gps',
  message: MESSAGES[status],
});

// Browser codes are exact; native errors arrive through the bridge as plain
// messages, so the text is the only thing left to read. Anything unrecognised
// is 'unavailable' rather than 'denied', because wrongly telling someone to
// change a permission they never refused sends them to the wrong screen.
const classifyError = (error) => {
  if (!error) return 'unavailable';

  if (error.code === 1) return 'denied';
  if (error.code === 2) return 'unavailable';
  if (error.code === 3) return 'timeout';

  const text = String(error.message || '').toLowerCase();
  if (text.includes('denied') || text.includes('permission')) return 'denied';
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  return 'unavailable';
};

// Capacitor's way of saying "this platform has no implementation of that
// method", as opposed to "I asked and the answer was no". The web build throws
// it from both permission calls: it has no requestPermissions at all, and
// checkPermissions needs a Permissions API not every browser has. Neither says
// anything about whether a fix is obtainable — in a browser it is
// getCurrentPosition itself that raises the prompt — so both mean carry on.
const isMethodMissing = (error) =>
  Boolean(error) && (error.code === 'UNIMPLEMENTED' || error.code === 'UNAVAILABLE');

// A PWA may not have Capacitor's web bridge registered. In that case use the
// phone browser's secure geolocation API directly; the permission prompt is
// raised by getCurrentPosition itself.
const browserProvider = {
  checkPermissions: async () => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
      throw Object.assign(new Error('Permissions API unavailable'), { code: 'UNAVAILABLE' });
    }
    const permission = await navigator.permissions.query({ name: 'geolocation' });
    return { location: permission.state === 'granted' ? 'granted' : permission.state === 'denied' ? 'denied' : 'prompt' };
  },
  requestPermissions: async () => ({ location: 'prompt' }),
  getCurrentPosition: (options) => new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(Object.assign(new Error('Geolocation is unavailable in this browser'), { code: 2 }));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  }),
};

const defaultProvider = {
  checkPermissions: async () => {
    try { return await Geolocation.checkPermissions(); } catch (error) {
      if (!isMethodMissing(error)) throw error;
      return browserProvider.checkPermissions();
    }
  },
  requestPermissions: async () => {
    try { return await Geolocation.requestPermissions(); } catch (error) {
      if (!isMethodMissing(error)) throw error;
      return browserProvider.requestPermissions();
    }
  },
  getCurrentPosition: async (options) => {
    try { return await Geolocation.getCurrentPosition(options); } catch (error) {
      if (!isMethodMissing(error)) throw error;
      return browserProvider.getCurrentPosition(options);
    }
  },
};

const TIMED_OUT = Symbol('timed out');

const withTimeout = (promise, ms) => {
  let timer;
  const stopwatch = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, stopwatch]).finally(() => clearTimeout(timer));
};

/**
 * Take one fix of the User Location and say what it is good for.
 *
 * Four statuses, because they are four different things to do about it:
 * 'located' (with or without a Nearest Station), 'denied' (change a setting),
 * 'unavailable' (nothing you can do here), 'timeout' (try again). A 'located'
 * result with no Nearest Station carries a `reason` — 'imprecise' when the fix
 * is too rough to choose, 'out-of-range' when there is genuinely nothing near —
 * because the map does the same thing in both cases and only the sentence
 * differs.
 *
 * @returns {Promise<object>}
 */
export const locate = async ({
  provider = defaultProvider,
  timeoutMs = FIX_TIMEOUT_MS,
  now = Date.now(),
} = {}) => {
  let permission = null;
  try {
    // The plugin throws from here when system location services are switched
    // off, which is a different fix from "allow this app" and gets its own
    // sentence.
    permission = await provider.checkPermissions();
  } catch (error) {
    if (!isMethodMissing(error)) return failure('unavailable');
  }

  if (permission && permission.location === 'denied') {
    // iOS will not re-prompt after a hard denial. Asking again burns a round
    // trip to be told the same thing.
    return failure('denied');
  }

  if (permission && permission.location !== 'granted') {
    try {
      const requested = await provider.requestPermissions();
      if (requested?.location === 'denied') return failure('denied');
    } catch (error) {
      if (!isMethodMissing(error)) return failure('unavailable');
      // No way to ask up front, so the prompt — and any refusal of it — arrives
      // from getCurrentPosition below instead.
    }
  }

  let position;
  try {
    position = await withTimeout(
      provider.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: FIX_MAX_AGE_MS,
      }),
      timeoutMs
    );
  } catch (error) {
    return failure(classifyError(error));
  }

  if (position === TIMED_OUT) return failure('timeout');
  if (!position || !position.coords) return failure('unavailable');

  const coordinates = [position.coords.longitude, position.coords.latitude];
  const accuracy = Number.isFinite(position.coords.accuracy)
    ? position.coords.accuracy
    : null;

  const located = {
    status: 'located',
    coordinates,
    accuracy,
    fetchedAt: now,
    nearestStation: null,
    distance: null,
    reason: null,
    source: 'device-gps',
    message: '',
  };

  if (accuracy !== null && accuracy > MAX_USABLE_ACCURACY_M) {
    return { ...located, reason: 'imprecise', message: MESSAGES.imprecise };
  }

  const nearest = findNearestStation(coordinates);
  if (!nearest || nearest.distance > NEAREST_STATION_RANGE_M) {
    return { ...located, reason: 'out-of-range', message: MESSAGES['out-of-range'] };
  }

  return {
    ...located,
    nearestStation: nearest.station,
    distance: nearest.distance,
    message: `${nearest.station.properties.name} · ${Math.round(nearest.distance)} m away`,
  };
};

export default locate;

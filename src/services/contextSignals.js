// Small, keyless context feeds used by the experimental prediction layer.
// Weather is deliberately kept separate from the official transit stores so
// a weather outage can never make the live map unavailable.
const WEATHER_KEY = 'vienna_weather_context_v1';
const WEATHER_REFRESH_MS = 30 * 60 * 1000;
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=48.2082&longitude=16.3738&current=temperature_2m,precipitation,rain,showers,snowfall,wind_speed_10m,weather_code&timezone=Europe%2FVienna';

const weatherDescription = (code) => {
  const values = {
    0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
    45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
    61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow',
    75: 'heavy snow', 80: 'rain showers', 81: 'showers', 82: 'heavy showers',
    95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
  };
  return values[Number(code)] || 'mixed conditions';
};

const readCached = () => {
  try {
    const value = JSON.parse(localStorage.getItem(WEATHER_KEY));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
};

const writeCached = (value) => {
  try { localStorage.setItem(WEATHER_KEY, JSON.stringify(value)); } catch { /* quota/private mode */ }
};

const initial = readCached();
let snapshot = initial?.current
  ? { ...initial, status: 'cached', error: null }
  : { status: 'not connected', current: null, fetchedAt: null, error: null };
let inFlight = null;
const listeners = new Set();

const notify = () => listeners.forEach((listener) => listener(snapshot));

export const normaliseWeather = (payload, fetchedAt = Date.now()) => {
  const current = payload?.current || {};
  const values = {
    temperature: Number(current.temperature_2m),
    precipitation: Number(current.precipitation),
    rain: Number(current.rain),
    showers: Number(current.showers),
    snowfall: Number(current.snowfall),
    windSpeed: Number(current.wind_speed_10m),
    weatherCode: Number(current.weather_code),
  };
  return {
    ...values,
    description: weatherDescription(values.weatherCode),
    fetchedAt,
    source: 'Open-Meteo Vienna current conditions',
  };
};

export const fetchViennaWeather = async ({ force = false } = {}) => {
  if (!force && snapshot.fetchedAt && Date.now() - snapshot.fetchedAt < WEATHER_REFRESH_MS) return snapshot;
  if (inFlight) return inFlight;
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(10000) : undefined;
  inFlight = fetch(WEATHER_URL, { signal })
    .then((response) => {
      if (!response.ok) throw new Error(`Weather feed returned HTTP ${response.status}`);
      return response.json();
    })
    .then((payload) => {
      const current = normaliseWeather(payload);
      snapshot = { status: 'live', current, fetchedAt: current.fetchedAt, error: null };
      writeCached(snapshot);
      notify();
      return snapshot;
    })
    .catch((error) => {
      snapshot = {
        ...snapshot,
        status: snapshot.current ? 'cached' : 'unavailable',
        error: String(error.message || error),
      };
      notify();
      return snapshot;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
};

export const weatherStore = {
  getSnapshot: () => snapshot,
  subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  refresh: fetchViennaWeather,
};

const STORAGE_KEY = 'vienna_commute_preferences_v1';
const MAX_STATIONS = 4;

const read = () => {
  if (typeof localStorage === 'undefined') return { stations: [], notifications: false };
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { stations: Array.isArray(value.stations) ? value.stations : [], notifications: Boolean(value.notifications) };
  } catch {
    return { stations: [], notifications: false };
  }
};

const write = (value) => {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  return value;
};

export const getCommutePreferences = () => read();

export const saveCommuteStation = (station, label = 'Favourite') => {
  const preferences = read();
  const summary = {
    name: station?.properties?.name || '',
    apiId: station?.properties?.apiId || null,
    lines: station?.properties?.lines || [],
    coordinates: station?.geometry?.coordinates || null,
    label: label || 'Favourite',
  };
  if (!summary.name) return preferences;
  const stations = [summary, ...preferences.stations.filter((item) => item.name !== summary.name)].slice(0, MAX_STATIONS);
  return write({ ...preferences, stations });
};

export const removeCommuteStation = (name) => {
  const preferences = read();
  return write({ ...preferences, stations: preferences.stations.filter((item) => item.name !== name) });
};

export const setCommuteNotifications = (enabled) => write({ ...read(), notifications: Boolean(enabled) });
export { MAX_STATIONS };

import { Capacitor } from '@capacitor/core';

const PUBLIC_API_BASE = String(import.meta.env.VITE_VIENNA_API_BASE || '').replace(/\/$/, '');
const REFRESH_INTERVAL_MS = 120000;
const U_BAHN_LINES = new Set(['U1', 'U2', 'U3', 'U4', 'U6']);

const buildTrafficInfoUrl = () => {
  if (Capacitor.isNativePlatform()) {
    return 'https://www.wienerlinien.at/ogd_realtime/trafficInfoList';
  }
  if (PUBLIC_API_BASE) return `${PUBLIC_API_BASE}/trafficInfoList`;
  return '/api/vienna/trafficInfoList';
};

const asArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

export const parseTrafficInfos = (payload) => {
  const infos = payload?.data?.trafficInfos;
  if (!Array.isArray(infos)) return [];

  return infos.map((item, index) => {
    const attributes = item.attributes || {};
    const relatedLines = asArray(item.relatedLines?.length ? item.relatedLines : attributes.relatedLines)
      .map(String)
      .filter((line) => U_BAHN_LINES.has(line));
    const searchable = [item.title, item.description, attributes.station, attributes.location, attributes.status]
      .map(cleanText).join(' ').toLowerCase();
    const isElevator = Number(item.refTrafficInfoCategoryId) === 1 || /aufzug|lift|elevator/.test(searchable);

    return {
      id: String(item.name || `traffic-${index}`),
      title: cleanText(item.title) || (isElevator ? 'Elevator unavailable' : 'Service information'),
      description: cleanText(item.description),
      lines: [...new Set(relatedLines)],
      station: cleanText(attributes.station),
      location: cleanText(attributes.location),
      reason: cleanText(attributes.reason),
      status: cleanText(attributes.status),
      towards: cleanText(attributes.towards),
      priority: Number(item.priority || attributes.priority || 0),
      startsAt: item.time?.start || null,
      endsAt: item.time?.end || null,
      isElevator,
    };
  }).filter((item) => item.lines.length > 0 || item.station);
};

class DisruptionStore {
  constructor() {
    this.snapshot = { alerts: [], status: 'idle', lastUpdated: null, error: null };
    this.listeners = new Set();
    this.inFlight = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  getSnapshot() {
    return this.snapshot;
  }

  async refresh() {
    if (this.inFlight) return this.inFlight;
    this.snapshot = { ...this.snapshot, status: 'loading', error: null };
    this.notify();

    this.inFlight = (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(buildTrafficInfoUrl(), {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        this.snapshot = {
          alerts: parseTrafficInfos(payload),
          status: 'ready',
          lastUpdated: Date.now(),
          error: null,
        };
      } catch {
        this.snapshot = {
          ...this.snapshot,
          status: this.snapshot.lastUpdated ? 'ready' : 'error',
          error: 'Service information is temporarily unavailable.',
        };
      } finally {
        clearTimeout(timeoutId);
        this.inFlight = null;
        this.notify();
      }
      return this.snapshot;
    })();

    return this.inFlight;
  }
}

export { REFRESH_INTERVAL_MS };
export const disruptionStore = new DisruptionStore();
export default disruptionStore;


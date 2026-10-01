// Compact history for the video-style Vienna Network Pulse.
//
// The map already has a five-second live observation cadence. This archive
// stores only the small counters needed by the visualisation—not coordinates
// or raw arrivals—so a later visit can reuse the recent service timeline
// without creating a second copy of the train feed.
import { deleteBrowserArchive, persistBrowserArchive, readBrowserArchive } from './browserArchive';

export const NETWORK_PULSE_KEY = 'vienna_network_pulse_v1';
export const NETWORK_PULSE_SAMPLE_INTERVAL_MS = 5000;
export const NETWORK_PULSE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const NETWORK_PULSE_LOCAL_CACHE_LIMIT = 120;
export const NETWORK_PULSE_PERSIST_INTERVAL_MS = 30 * 1000;

const classifyLine = (line) => {
  const id = String(line || '').trim().toUpperCase();
  if (id.startsWith('U')) return 'ubahn';
  if (id.startsWith('S') || id === 'CAT' || id.includes('AIRPORT')) return 'sbahn';
  return 'tram';
};

export const compactNetworkPulseSample = (vehicles = [], alertCount = 0, at = Date.now()) => {
  const list = Array.isArray(vehicles) ? vehicles : [];
  const live = list.filter((vehicle) => vehicle.isLive);
  const fresh = live.filter((vehicle) => Number(vehicle.lastDataAgeSeconds) <= 3);
  const lines = new Set(list.map((vehicle) => String(vehicle.line || '').trim()).filter(Boolean));
  const categories = { ubahn: 0, sbahn: 0, tram: 0 };
  list.forEach((vehicle) => { categories[classifyLine(vehicle.line)] += 1; });
  return {
    schemaVersion: 1,
    at: Number(at) || Date.now(),
    trains: list.length,
    live: live.length,
    fresh: fresh.length,
    lines: lines.size,
    ubahn: categories.ubahn,
    sbahn: categories.sbahn,
    tram: categories.tram,
    alerts: Number(alertCount) || 0,
  };
};

const readLocal = () => {
  try {
    if (typeof localStorage === 'undefined') return [];
    const value = JSON.parse(localStorage.getItem(NETWORK_PULSE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const validSamples = (samples, now = Date.now()) => {
  const cutoff = now - NETWORK_PULSE_RETENTION_MS;
  return [...new Map((Array.isArray(samples) ? samples : [])
    .filter((sample) => Number.isFinite(Number(sample?.at)) && Number(sample.at) >= cutoff && Number(sample.trains) >= 0)
    .sort((a, b) => Number(a.at) - Number(b.at))
    .map((sample) => [Number(sample.at), { ...sample, at: Number(sample.at) }]))
    .values()];
};

class NetworkPulseStore {
  constructor() {
    this.samples = validSamples(readLocal());
    this.lastSampleAt = this.samples.at(-1)?.at || 0;
    this.lastPersistAt = 0;
    this.listeners = new Set();
    void readBrowserArchive(NETWORK_PULSE_KEY).then((stored) => {
      const merged = validSamples([...this.samples, ...(Array.isArray(stored) ? stored : [])]);
      this.samples = merged;
      this.lastSampleAt = this.samples.at(-1)?.at || this.lastSampleAt;
      this.notify();
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => {
      try { listener(snapshot); } catch { /* consumers cannot stop collection */ }
    });
  }

  persist(force = false) {
    const now = Date.now();
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(NETWORK_PULSE_KEY, JSON.stringify(this.samples.slice(-NETWORK_PULSE_LOCAL_CACHE_LIMIT)));
      }
    } catch { /* private browsing or quota exhaustion must not break the map */ }
    if (force || now - this.lastPersistAt >= NETWORK_PULSE_PERSIST_INTERVAL_MS) {
      this.lastPersistAt = now;
      void persistBrowserArchive(NETWORK_PULSE_KEY, this.samples);
    }
  }

  record(vehicles = [], alertCount = 0, at = Date.now()) {
    const list = Array.isArray(vehicles) ? vehicles : [];
    // An empty startup cache is not a real zero-service observation.
    if (!list.length || Number(at) - this.lastSampleAt < NETWORK_PULSE_SAMPLE_INTERVAL_MS - 250) return false;
    const sample = compactNetworkPulseSample(list, alertCount, at);
    this.samples = validSamples([...this.samples, sample], at);
    this.lastSampleAt = sample.at;
    this.persist();
    this.notify();
    return true;
  }

  seed(samples = []) {
    const merged = validSamples([...this.samples, ...(Array.isArray(samples) ? samples : [])]);
    if (merged.length <= this.samples.length) return false;
    this.samples = merged;
    this.lastSampleAt = this.samples.at(-1)?.at || this.lastSampleAt;
    this.persist(true);
    this.notify();
    return true;
  }

  getSamples() { return this.samples.slice(); }

  getSnapshot() {
    return {
      first: this.samples[0]?.at || null,
      last: this.samples.at(-1)?.at || null,
      samples: this.samples.slice(),
    };
  }

  clear() {
    this.samples = [];
    this.lastSampleAt = 0;
    this.persist(true);
    void deleteBrowserArchive(NETWORK_PULSE_KEY);
    this.notify();
  }
}

export const networkPulseStore = new NetworkPulseStore();
export default networkPulseStore;

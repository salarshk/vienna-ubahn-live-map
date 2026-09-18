// Delay leaderboard and long-horizon report archive.
//
// Live rankings are calculated from the current official departure cache.
// Historical reports are compact aggregates written to IndexedDB through the
// browser archive helper. This keeps storage bounded while preserving hourly,
// daily, weekly, monthly and yearly rankings.
import { deleteBrowserArchive, persistBrowserArchive, readBrowserArchive } from './browserArchive';

export const DELAY_REPORT_KEY = 'vienna_delay_reports_v1';
export const DELAY_REPORT_SAMPLE_INTERVAL_MS = 60 * 1000;

const PERIODS = {
  hourly: { retention: 24 * 14, bucket: (date) => date.toISOString().slice(0, 13) },
  daily: { retention: 370, bucket: (date) => date.toISOString().slice(0, 10) },
  weekly: { retention: 110, bucket: (date) => {
    const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = copy.getUTCDay() || 7;
    copy.setUTCDate(copy.getUTCDate() - day + 1);
    return copy.toISOString().slice(0, 10);
  } },
  monthly: { retention: 72, bucket: (date) => date.toISOString().slice(0, 7) },
  yearly: { retention: 10, bucket: (date) => date.toISOString().slice(0, 4) },
};

const emptyState = () => ({ version: 1, lastRecordedAt: 0, observations: 0, buckets: Object.fromEntries(Object.keys(PERIODS).map((period) => [period, {}])) });
const asArray = (value) => Array.isArray(value) ? value : [];
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const localRead = () => {
  try {
    if (typeof localStorage === 'undefined') return null;
    const parsed = JSON.parse(localStorage.getItem(DELAY_REPORT_KEY) || 'null');
    return parsed?.buckets ? parsed : null;
  } catch { return null; }
};

const rowKey = (arrival) => {
  const vehicle = arrival.vehicleId || arrival.vehicleName;
  if (vehicle) return String(vehicle);
  return `${arrival.line || '—'}|${arrival.directionCode || '—'}|${arrival.destination || '—'}|${arrival.plannedTargetTimestamp || arrival.targetTimestamp || '—'}`;
};

export const flattenDelayEntries = (entries = []) => asArray(entries).flatMap((entry) => asArray(entry?.arrivals).map((arrival) => ({
  ...arrival,
  stationName: arrival.stationName || entry.stationName || entry.name || 'Unknown station',
  delaySeconds: finite(arrival.reportedDelaySeconds),
  trainKey: rowKey(arrival),
}))).filter((arrival) => arrival.delaySeconds !== null && arrival.isLive !== false);

const summaryFor = (rows, key) => {
  const groups = new Map();
  rows.forEach((row) => {
    const id = String(row[key] || '—');
    const current = groups.get(id) || { id, samples: 0, delaySumSeconds: 0, maxDelaySeconds: -Infinity, delayedThreeMinutes: 0, lastObservedAt: 0 };
    current.samples += 1;
    current.delaySumSeconds += Number(row.delaySeconds);
    current.maxDelaySeconds = Math.max(current.maxDelaySeconds, Number(row.delaySeconds));
    if (Number(row.delaySeconds) >= 180) current.delayedThreeMinutes += 1;
    current.lastObservedAt = Math.max(current.lastObservedAt, Number(row.observedAt) || 0);
    groups.set(id, current);
  });
  return [...groups.values()].map((item) => ({
    ...item,
    meanDelaySeconds: Math.round(item.delaySumSeconds / Math.max(1, item.samples)),
    maxDelaySeconds: Number.isFinite(item.maxDelaySeconds) ? item.maxDelaySeconds : null,
  })).sort((a, b) => b.meanDelaySeconds - a.meanDelaySeconds || b.maxDelaySeconds - a.maxDelaySeconds || b.samples - a.samples);
};

export const buildDelayRankings = (entries = [], now = Date.now()) => {
  const rows = flattenDelayEntries(entries).map((row) => ({ ...row, observedAt: now }));
  return {
    observedAt: now,
    observations: rows.length,
    trains: summaryFor(rows, 'trainKey').map((item) => {
      const row = rows.find((candidate) => candidate.trainKey === item.id);
      return { ...item, trainKey: item.id, line: row?.line || '—', station: row?.stationName || '—', destination: row?.destination || '—', direction: row?.directionCode || '—', vehicleId: row?.vehicleId || null };
    }),
    stations: summaryFor(rows, 'stationName').map((item) => ({ ...item, station: item.id, lines: [...new Set(rows.filter((row) => row.stationName === item.id).map((row) => row.line).filter(Boolean))] })),
    lines: summaryFor(rows, 'line').map((item) => ({ ...item, line: item.id })),
  };
};

const updateStats = (collection, key, value, at) => {
  const id = String(key || '—');
  const current = collection[id] || { id, samples: 0, delaySumSeconds: 0, maxDelaySeconds: -Infinity, delayedThreeMinutes: 0, lastObservedAt: 0 };
  current.samples += 1;
  current.delaySumSeconds += Number(value);
  current.maxDelaySeconds = Math.max(current.maxDelaySeconds, Number(value));
  if (Number(value) >= 180) current.delayedThreeMinutes += 1;
  current.lastObservedAt = Math.max(current.lastObservedAt, at);
  collection[id] = current;
};

const prune = (state, now) => {
  Object.entries(PERIODS).forEach(([period, config]) => {
    const keys = Object.keys(state.buckets[period] || {}).sort();
    state.buckets[period] = Object.fromEntries(keys.slice(-config.retention).map((key) => [key, state.buckets[period][key]]));
  });
  state.lastRecordedAt = now;
  return state;
};

const reportStats = (stats = {}) => Object.values(stats).map((item) => ({
  ...item,
  meanDelaySeconds: Math.round(Number(item.delaySumSeconds || 0) / Math.max(1, Number(item.samples) || 0)),
  maxDelaySeconds: Number.isFinite(Number(item.maxDelaySeconds)) ? Number(item.maxDelaySeconds) : null,
})).sort((a, b) => b.meanDelaySeconds - a.meanDelaySeconds || b.maxDelaySeconds - a.maxDelaySeconds || b.samples - a.samples);

const aggregateBucket = (buckets, from, to) => {
  const dimensions = { trains: {}, stations: {}, lines: {} };
  let samples = 0;
  Object.entries(buckets || {}).forEach(([key, bucket]) => {
    const at = bucket.at || Date.parse(key);
    if (Number.isFinite(at) && (at < from || at > to)) return;
    samples += Number(bucket.samples) || 0;
    ['trains', 'stations', 'lines'].forEach((dimension) => Object.entries(bucket[dimension] || {}).forEach(([id, stats]) => {
      const target = dimensions[dimension][id] || { id, samples: 0, delaySumSeconds: 0, maxDelaySeconds: -Infinity, delayedThreeMinutes: 0, lastObservedAt: 0 };
      target.samples += Number(stats.samples) || 0;
      target.delaySumSeconds += Number(stats.delaySumSeconds) || 0;
      target.maxDelaySeconds = Math.max(target.maxDelaySeconds, Number(stats.maxDelaySeconds));
      target.delayedThreeMinutes += Number(stats.delayedThreeMinutes) || 0;
      target.lastObservedAt = Math.max(target.lastObservedAt, Number(stats.lastObservedAt) || 0);
      dimensions[dimension][id] = target;
    }));
  });
  return { samples, trains: reportStats(dimensions.trains), stations: reportStats(dimensions.stations), lines: reportStats(dimensions.lines) };
};

const periodWindow = (period, now) => {
  const end = Number(now) || Date.now();
  const durations = { hourly: 60 * 60 * 1000, daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000, monthly: 31 * 24 * 60 * 60 * 1000, yearly: 366 * 24 * 60 * 60 * 1000 };
  return { from: end - (durations[period] || durations.daily), to: end };
};

class DelayReportStore {
  constructor() {
    this.state = localRead() || emptyState();
    this.listeners = new Set();
    void readBrowserArchive(DELAY_REPORT_KEY).then((stored) => {
      if (!stored?.buckets) return;
      this.state = prune({ ...emptyState(), ...stored, buckets: { ...emptyState().buckets, ...stored.buckets } }, Date.now());
      this.notify();
    });
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() { const snapshot = this.getSnapshot(); this.listeners.forEach((listener) => { try { listener(snapshot); } catch { /* consumer errors do not stop reporting */ } }); }

  record(entries = [], at = Date.now()) {
    if (at - Number(this.state.lastRecordedAt || 0) < DELAY_REPORT_SAMPLE_INTERVAL_MS) return false;
    const rows = flattenDelayEntries(entries);
    if (!rows.length) return false;
    Object.entries(PERIODS).forEach(([period, config]) => {
      const date = new Date(at);
      const key = config.bucket(date);
      const bucket = this.state.buckets[period][key] || { at, samples: 0, trains: {}, stations: {}, lines: {} };
      bucket.at = Math.min(Number(bucket.at) || at, at);
      bucket.samples += rows.length;
      rows.forEach((row) => {
        updateStats(bucket.trains, row.trainKey, row.delaySeconds, at);
        updateStats(bucket.stations, row.stationName, row.delaySeconds, at);
        updateStats(bucket.lines, row.line, row.delaySeconds, at);
      });
      this.state.buckets[period][key] = bucket;
    });
    this.state.observations = Number(this.state.observations || 0) + rows.length;
    this.state = prune(this.state, at);
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(DELAY_REPORT_KEY, JSON.stringify(this.state)); } catch { /* IndexedDB remains the full archive */ }
    void persistBrowserArchive(DELAY_REPORT_KEY, this.state);
    this.notify();
    return true;
  }

  getReport(period = 'daily', now = Date.now()) {
    const safePeriod = PERIODS[period] ? period : 'daily';
    const { from, to } = periodWindow(safePeriod, now);
    const report = aggregateBucket(this.state.buckets[safePeriod], from, to);
    return { period: safePeriod, from, to, ...report, generatedAt: now };
  }

  getSnapshot() {
    return { lastRecordedAt: this.state.lastRecordedAt || null, observations: this.state.observations || 0, buckets: Object.fromEntries(Object.entries(this.state.buckets).map(([period, values]) => [period, Object.keys(values).length])) };
  }

  clear() {
    this.state = emptyState();
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(DELAY_REPORT_KEY); } catch { /* ignore */ }
    void deleteBrowserArchive(DELAY_REPORT_KEY);
    this.notify();
  }
}

export const delayReportStore = new DelayReportStore();
export { PERIODS };
export default delayReportStore;

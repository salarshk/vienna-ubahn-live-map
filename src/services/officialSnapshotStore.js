// Ten-minute archive of the official Wiener Linien departure observations.
//
// The map can infer a train's position from an official departure prediction,
// but that position is not itself an official GPS measurement. Keeping the two
// layers separate makes the history view honest and gives the delay model a
// compact, user-visible audit trail.
import arrivalStore from './arrivalStore';
import { deleteBrowserArchive, persistBrowserArchive, readBrowserArchive } from './browserArchive';

export const OFFICIAL_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
export const OFFICIAL_SNAPSHOT_RETENTION_MS = 48 * 60 * 60 * 1000;
export const OFFICIAL_SNAPSHOT_KEY = 'vienna_official_snapshots_v1';
export const OFFICIAL_LOCAL_CACHE_LIMIT = 24;

const readSnapshots = () => {
  try {
    if (typeof localStorage === 'undefined') return [];
    const parsed = JSON.parse(localStorage.getItem(OFFICIAL_SNAPSHOT_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((snapshot) => Array.isArray(snapshot?.arrivals)) : [];
  } catch {
    return [];
  }
};

const writeSnapshots = (snapshots) => {
  try {
    if (typeof localStorage !== 'undefined') {
      // Keep only a small synchronous startup cache; IndexedDB receives the
      // full 48-hour archive below.
      localStorage.setItem(OFFICIAL_SNAPSHOT_KEY, JSON.stringify(snapshots.slice(-OFFICIAL_LOCAL_CACHE_LIMIT)));
    }
  } catch {
    // Private browsing or a full quota must not interrupt the live map.
  }
  void persistBrowserArchive(OFFICIAL_SNAPSHOT_KEY, snapshots);
};

const roundDelay = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;

export const compactOfficialSnapshot = (entries, at = Date.now()) => {
  const allArrivals = (Array.isArray(entries) ? entries : []).flatMap((entry) => (
    (Array.isArray(entry?.arrivals) ? entry.arrivals : [])
      .filter((arrival) => arrival?.isLive && Number.isFinite(arrival.targetTimestamp))
      .map((arrival) => ({
        stationId: Number(entry.stationId) || null,
        stationName: entry.stationName || 'Unknown station',
        line: arrival.line,
        direction: arrival.directionCode || null,
        destination: arrival.destination || null,
        plannedTimestamp: Number(arrival.plannedTargetTimestamp),
        realtimeTimestamp: Number(arrival.targetTimestamp),
        officialDelaySeconds: roundDelay(arrival.reportedDelaySeconds),
        // This value is an official Wiener Linien timeReal/timePlanned pair;
        // the position later inferred from it is deliberately not labeled GPS.
        labelSource: arrival.delaySource || 'wiener-linien-timeReal-minus-timePlanned',
        barrierFree: arrival.barrierFree ?? null,
        trafficJam: Boolean(arrival.trafficJam),
        platform: arrival.platform ?? null,
        gate: arrival.gate ?? null,
        rbl: arrival.rbl ?? null,
        lineId: arrival.lineId ?? null,
        routeDirectionId: arrival.routeDirectionId ?? null,
        vehicleId: arrival.vehicleId ?? null,
        vehicleName: arrival.vehicleName ?? null,
        vehicleType: arrival.vehicleType ?? null,
        onStop: arrival.onStop ?? null,
        foldingRamp: arrival.foldingRamp ?? null,
        cooling: arrival.cooling ?? null,
        exactGpsCoordinates: arrival.exactGpsCoordinates ?? null,
        exactGpsAvailable: Boolean(arrival.exactGpsAvailable),
        positionSource: arrival.positionSource || 'inferred-from-departure-prediction',
        feedServerTime: arrival.feedServerTime ?? null,
        feedAgeSeconds: arrival.feedAgeSeconds ?? null,
      }))
  )).filter((arrival) => Number.isFinite(arrival.plannedTimestamp));

  // Keep the browser archive compact: the training workflow retains every
  // official row, while the UI only needs line-level delay statistics and a
  // few worst-delay examples to explain a replay frame.
  const grouped = new Map();
  for (const arrival of allArrivals) {
    const list = grouped.get(arrival.line) || [];
    list.push(arrival);
    grouped.set(arrival.line, list);
  }
  const lineSummary = [...grouped.entries()].map(([line, values]) => {
    const delays = values.map((value) => Number(value.officialDelaySeconds)).filter(Number.isFinite);
    return {
      line,
      observations: values.length,
      labelledObservations: delays.length,
      delaySumSeconds: delays.reduce((sum, value) => sum + value, 0),
      delayedThreeMinutes: delays.filter((value) => value >= 180).length,
      maxDelaySeconds: delays.length ? Math.max(...delays) : null,
    };
  });
  const arrivals = [...grouped.values()].flatMap((values) => values
    .sort((a, b) => (Number(b.officialDelaySeconds) || -Infinity) - (Number(a.officialDelaySeconds) || -Infinity))
    .slice(0, 8));

  return {
    at,
    source: 'wiener-linien-monitor',
    sourceLabel: 'Wiener Linien official departure predictions',
    stations: new Set(allArrivals.map((arrival) => arrival.stationId).filter(Boolean)).size,
    observations: allArrivals.length,
    labelledObservations: allArrivals.filter((arrival) => Number.isFinite(Number(arrival.officialDelaySeconds))).length,
    lineSummary,
    arrivals,
  };
};

export const summariseOfficialSnapshot = (snapshot) => {
  const arrivals = Array.isArray(snapshot?.arrivals) ? snapshot.arrivals : [];
  const storedLineSummary = Array.isArray(snapshot?.lineSummary) ? snapshot.lineSummary : null;
  const delays = arrivals
    .map((arrival) => Number(arrival.officialDelaySeconds))
    .filter(Number.isFinite);
  const byLine = new Map();
  for (const arrival of arrivals) {
    const line = String(arrival.line || '—');
    const list = byLine.get(line) || [];
    if (Number.isFinite(Number(arrival.officialDelaySeconds))) list.push(Number(arrival.officialDelaySeconds));
    byLine.set(line, list);
  }
  const lines = storedLineSummary
    ? storedLineSummary.map((line) => ({
      line: line.line,
      observations: Number(line.observations) || 0,
      meanDelaySeconds: Number(line.labelledObservations)
        ? Math.round(Number(line.delaySumSeconds || 0) / Number(line.labelledObservations))
        : null,
      maxDelaySeconds: Number.isFinite(Number(line.maxDelaySeconds)) ? Number(line.maxDelaySeconds) : null,
    }))
    : [...byLine.entries()].map(([line, values]) => ({
      line,
      observations: values.length,
      meanDelaySeconds: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
      maxDelaySeconds: values.length ? Math.max(...values) : null,
    }));
  const storedDelays = storedLineSummary
    ? storedLineSummary.reduce((sum, line) => sum + Number(line.labelledObservations || 0), 0)
    : delays.length;
  const storedDelaySum = storedLineSummary
    ? storedLineSummary.reduce((sum, line) => sum + Number(line.delaySumSeconds || 0), 0)
    : delays.reduce((sum, value) => sum + value, 0);
  const storedDelayedThreeMinutes = storedLineSummary
    ? storedLineSummary.reduce((sum, line) => sum + Number(line.delayedThreeMinutes || 0), 0)
    : delays.filter((value) => value >= 180).length;
  return {
    at: Number(snapshot?.at) || null,
    source: snapshot?.source || 'wiener-linien-monitor',
    sourceLabel: snapshot?.sourceLabel || 'Wiener Linien official departure predictions',
    stations: Number(snapshot?.stations) || 0,
    observations: Number(snapshot?.observations) || arrivals.length,
    labelledObservations: Number(snapshot?.labelledObservations) || storedDelays,
    meanDelaySeconds: storedDelays ? Math.round(storedDelaySum / storedDelays) : null,
    delayedThreeMinutes: storedDelayedThreeMinutes,
    lines: lines.sort((a, b) => a.line.localeCompare(b.line)),
  };
};

class OfficialSnapshotStore {
  constructor() {
    this.snapshots = readSnapshots().sort((a, b) => Number(a.at) - Number(b.at));
    this.lastSnapshotAt = this.snapshots.at(-1)?.at || 0;
    this.listeners = new Set();
    void readBrowserArchive(OFFICIAL_SNAPSHOT_KEY).then((stored) => {
      if (!Array.isArray(stored)) return;
      const cutoff = Date.now() - OFFICIAL_SNAPSHOT_RETENTION_MS;
      const merged = [...this.snapshots, ...stored]
        .filter((snapshot) => Number(snapshot?.at) >= cutoff && Array.isArray(snapshot?.arrivals))
        .sort((a, b) => Number(a.at) - Number(b.at));
      this.snapshots = [...new Map(merged.map((snapshot) => [snapshot.at, snapshot])).values()];
      this.lastSnapshotAt = this.snapshots.at(-1)?.at || this.lastSnapshotAt;
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
      try { listener(snapshot); } catch { /* consumer errors do not stop collection */ }
    });
  }

  record(at = Date.now(), entries = [...arrivalStore.memory.values()]) {
    if (at - this.lastSnapshotAt < OFFICIAL_SNAPSHOT_INTERVAL_MS) return false;
    const snapshot = compactOfficialSnapshot(entries, at);
    if (snapshot.arrivals.length === 0) return false;
    this.snapshots.push(snapshot);
    this.snapshots = this.snapshots.filter((item) => at - Number(item.at) <= OFFICIAL_SNAPSHOT_RETENTION_MS);
    this.lastSnapshotAt = at;
    writeSnapshots(this.snapshots);
    this.notify();
    return true;
  }

  getAtOffset(minutesAgo = 0, now = Date.now()) {
    if (!this.snapshots.length) return null;
    const wanted = now - Math.max(0, Number(minutesAgo) || 0) * 60000;
    return this.snapshots.reduce((best, candidate) => (
      !best || Math.abs(Number(candidate.at) - wanted) < Math.abs(Number(best.at) - wanted)
        ? candidate : best
    ), null);
  }

  getSnapshot() {
    const first = this.snapshots[0]?.at || null;
    const last = this.snapshots.at(-1)?.at || null;
    return {
      first,
      last,
      samples: this.snapshots.length,
      oldestMinutes: first ? Math.max(0, Math.floor((Date.now() - first) / 60000)) : 0,
      latest: this.snapshots.at(-1) ? summariseOfficialSnapshot(this.snapshots.at(-1)) : null,
    };
  }

  clear() {
    this.snapshots = [];
    this.lastSnapshotAt = 0;
    writeSnapshots([]);
    void deleteBrowserArchive(OFFICIAL_SNAPSHOT_KEY);
    this.notify();
  }
}

export const officialSnapshotStore = new OfficialSnapshotStore();
export default officialSnapshotStore;

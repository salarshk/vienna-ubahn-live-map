import arrivalStore from './arrivalStore';
import trainPositionEngine from './trainPositionEngine';

const REPLAY_KEY = 'vienna_rail_replay_v1';
const RELIABILITY_KEY = 'vienna_rail_reliability_v1';
const REPLAY_WINDOW_MS = 60 * 60 * 1000;
const SNAPSHOT_INTERVAL_MS = 30 * 1000;
const RELIABILITY_INTERVAL_MS = 5 * 60 * 1000;
const RELIABILITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STATION_AGE_MS = 5 * 60 * 1000;

export const GAP_SECONDS = 7 * 60;
export const BUNCH_SECONDS = 2 * 60;

const read = (key, fallback) => {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const parsed = JSON.parse(localStorage.getItem(key));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const write = (key, value) => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A private browser or a full storage quota should not break the live map.
  }
};

const compactVehicle = (vehicle) => ({
  id: vehicle.id,
  line: vehicle.line,
  direction: vehicle.direction,
  coordinates: vehicle.coordinates,
  bearing: vehicle.bearing,
  distanceAlongTrack: vehicle.distanceAlongTrack,
  isForward: vehicle.isForward,
  isLive: vehicle.isLive,
  isScheduled: vehicle.isScheduled,
  isSimulated: vehicle.isSimulated,
  status: vehicle.status,
  sightingCount: vehicle.sightingCount,
  positionUncertaintyMetres: vehicle.positionUncertaintyMetres,
  positionConfidence: vehicle.positionConfidence,
  positionRangeCoordinates: vehicle.positionRangeCoordinates,
  isDeadReckoned: vehicle.isDeadReckoned,
  secondsUnheard: vehicle.secondsUnheard,
  targetStation: vehicle.targetStation,
  previousStation: vehicle.previousStation,
  upcomingStations: vehicle.upcomingStations,
  secondsToTarget: vehicle.secondsToTarget,
});

/**
 * Detect unusually short and long intervals from the predictions themselves.
 * This is intentionally not based on map-marker distance: a sparse public feed
 * can omit a vehicle without implying that the real service has a gap.
 */
export const analyseHeadwayEntries = (entries, now = Date.now()) => {
  const candidates = [];

  for (const entry of entries || []) {
    if (!entry || !Array.isArray(entry.arrivals)) continue;
    if (!Number.isFinite(entry.fetchedAt) || now - entry.fetchedAt > MAX_STATION_AGE_MS) continue;

    const groups = new Map();
    for (const arrival of entry.arrivals) {
      if (!arrival.isLive || !String(arrival.line).startsWith('U')) continue;
      if (!Number.isFinite(arrival.targetTimestamp) || arrival.targetTimestamp < now - 40000) continue;
      const key = `${arrival.line}|${arrival.directionCode || arrival.destination}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(arrival);
    }

    for (const arrivals of groups.values()) {
      arrivals.sort((a, b) => a.targetTimestamp - b.targetTimestamp);
      for (let index = 1; index < arrivals.length; index += 1) {
        const previous = arrivals[index - 1];
        const next = arrivals[index];
        const seconds = Math.round((next.targetTimestamp - previous.targetTimestamp) / 1000);
        if (seconds <= 0) continue;
        if (seconds < BUNCH_SECONDS) {
          candidates.push({
            id: `bunch-${previous.line}-${previous.directionCode || previous.destination}-${entry.stationId}`,
            type: 'bunch',
            severity: BUNCH_SECONDS - seconds,
            line: previous.line,
            direction: previous.destination,
            station: entry.stationName,
            seconds,
            label: `${Math.max(1, Math.round(seconds / 60))} min between trains`,
          });
        } else if (seconds > GAP_SECONDS) {
          candidates.push({
            id: `gap-${previous.line}-${previous.directionCode || previous.destination}-${entry.stationId}`,
            type: 'gap',
            severity: seconds - GAP_SECONDS,
            line: previous.line,
            direction: previous.destination,
            station: entry.stationName,
            seconds,
            label: `${Math.round(seconds / 60)} min service gap`,
          });
        }
      }
    }
  }

  // One alert per type, line and direction. The most extreme station is the
  // clearest evidence and avoids listing the same gap at every reference stop.
  const strongest = new Map();
  for (const issue of candidates) {
    const key = `${issue.type}|${issue.line}|${issue.direction}`;
    const current = strongest.get(key);
    if (!current || issue.severity > current.severity) strongest.set(key, issue);
  }
  return [...strongest.values()].sort((a, b) => b.severity - a.severity);
};

export const analyseHeadways = (now = Date.now()) =>
  analyseHeadwayEntries([...arrivalStore.memory.values()], now);

const normalCdfApprox = (z) => 1 / (1 + Math.exp(-1.702 * z));

/**
 * Probabilistic U-Bahn connections from a selected train's next interchange.
 * The result is an estimate, not a guarantee: the public feed supplies neither
 * passenger walking speed nor a continuous vehicle location.
 */
export const estimateConnections = (vehicle, now = Date.now()) => {
  if (!vehicle?.isLive || !vehicle.targetStation) return [];
  const ownTrack = trainPositionEngine.getLineTrack(vehicle.line);
  const metresPerSecond = ownTrack?.fallbackSpeed || 7.5;
  const positionSeconds = (vehicle.positionUncertaintyMetres || 250) / metresPerSecond;
  const sigmaSeconds = Math.max(35, Math.min(180, positionSeconds + 30));
  const transferSeconds = 120;
  const target = trainPositionEngine.findStation(vehicle.line, vehicle.targetStation);
  const names = [vehicle.targetStation, ...(vehicle.upcomingStations || [])]
    .filter((name, index, all) => name && all.indexOf(name) === index)
    .slice(0, 3);

  for (const stationName of names) {
    const station = trainPositionEngine.findStation(vehicle.line, stationName);
    const extraSeconds = target && station
      ? trainPositionEngine.getSecondsBetweenStations(vehicle.line, target, station)
      : 0;
    const arrivalAt = now + (Math.max(0, vehicle.secondsToTarget || 0) + extraSeconds) * 1000;
    const entry = [...arrivalStore.memory.values()].find(
      (candidate) => candidate?.stationName === stationName
    );
    if (!entry) continue;
    const projected = arrivalStore.projectArrivals(entry, now)
      .filter((arrival) => arrival.line !== vehicle.line && arrival.targetTimestamp > arrivalAt);

    const byService = new Map();
    for (const connection of projected) {
      const key = `${connection.line}|${connection.directionCode || connection.destination}`;
      if (!byService.has(key)) byService.set(key, connection);
    }
    if (byService.size === 0) continue;

    return [...byService.values()].map((connection) => {
      const marginSeconds = (connection.targetTimestamp - arrivalAt) / 1000 - transferSeconds;
      // Never imply certainty from a feed that has no GPS or passenger walking
      // measurement, even when the timetable margin is very large.
      const probability = Math.max(2, Math.min(
        98,
        Math.round(normalCdfApprox(marginSeconds / sigmaSeconds) * 100)
      ));
      return {
        station: stationName,
        line: connection.line,
        destination: connection.destination,
        departureSeconds: Math.max(0, Math.round((connection.targetTimestamp - now) / 1000)),
        marginSeconds: Math.round(marginSeconds),
        probability,
        rating: probability >= 80 ? 'comfortable' : probability >= 50 ? 'tight' : 'unlikely',
      };
    }).sort((a, b) => b.probability - a.probability || a.departureSeconds - b.departureSeconds).slice(0, 4);
  }
  return [];
};

class NetworkIntelligenceStore {
  constructor() {
    this.listeners = new Set();
    this.snapshots = read(REPLAY_KEY, []).filter(
      (snapshot) => Array.isArray(snapshot?.vehicles) && snapshot.vehicles.length > 0
    );
    this.reliability = read(RELIABILITY_KEY, []);
    this.lastSnapshotAt = this.snapshots.at(-1)?.at || 0;
    this.lastReliabilityAt = this.reliability.at(-1)?.at || 0;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => {
      try { listener(snapshot); } catch { /* Ignore consumer failures. */ }
    });
  }

  record(now = Date.now()) {
    if (now - this.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
      const vehicles = trainPositionEngine.getAllVehicles(now)
        .filter((vehicle) => vehicle.isLive)
        .map(compactVehicle);
      // Startup briefly has no live U-Bahn evidence while the first network
      // sweep is in flight. Recording that would make replay appear to erase
      // the network, so only usable observations become frames.
      if (vehicles.length > 0) {
        this.snapshots.push({ at: now, vehicles });
        this.snapshots = this.snapshots.filter((snapshot) => now - snapshot.at <= REPLAY_WINDOW_MS);
        this.lastSnapshotAt = now;
        write(REPLAY_KEY, this.snapshots);
      }
    }

    if (now - this.lastReliabilityAt >= RELIABILITY_INTERVAL_MS) {
      const hasLiveEvidence = [...arrivalStore.memory.values()].some((entry) =>
        Number.isFinite(entry?.fetchedAt) && now - entry.fetchedAt <= MAX_STATION_AGE_MS &&
        entry.arrivals?.some((arrival) => arrival.isLive)
      );
      if (hasLiveEvidence) {
        const issues = analyseHeadways(now);
        const affected = new Set(issues.map((issue) => issue.line));
        this.reliability.push({ at: now, affected: [...affected] });
        this.reliability = this.reliability.filter((item) => now - item.at <= RELIABILITY_WINDOW_MS);
        this.lastReliabilityAt = now;
        write(RELIABILITY_KEY, this.reliability);
      }
    }
    this.notify();
  }

  getReplaySnapshot(minutesAgo = 0, now = Date.now()) {
    if (minutesAgo <= 0 || this.snapshots.length === 0) return null;
    const wanted = now - minutesAgo * 60 * 1000;
    return this.snapshots.reduce((best, candidate) => (
      !best || Math.abs(candidate.at - wanted) < Math.abs(best.at - wanted) ? candidate : best
    ), null);
  }

  getReliabilityByLine() {
    const lines = ['U1', 'U2', 'U3', 'U4', 'U6'];
    return lines.map((line) => {
      const observations = this.reliability.length;
      const affected = this.reliability.filter((item) => item.affected.includes(line)).length;
      return {
        line,
        observations,
        score: observations ? Math.round(100 * (1 - affected / observations)) : null,
      };
    });
  }

  getSnapshot() {
    const first = this.snapshots[0]?.at || null;
    const last = this.snapshots.at(-1)?.at || null;
    return {
      issues: analyseHeadways(),
      replay: { first, last, samples: this.snapshots.length },
      reliability: this.getReliabilityByLine(),
    };
  }
}

export const networkIntelligenceStore = new NetworkIntelligenceStore();
export default networkIntelligenceStore;

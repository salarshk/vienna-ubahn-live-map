// Vienna U-Bahn arrival memory: client-side cache, wall-clock countdowns and
// a small network seeder for Wiener Linien's keyless real-time monitor API.
import { Capacitor } from '@capacitor/core';
import metroData from '../data/metro_lines.json';
import imageLineColors from '../data/line_colors_from_image.json';
import paradasApi from '../data/paradas_api.json';
import sbahnData from '../data/sbahn_network.json';

// Build the U-Bahn station name -> Wiener Linien DIVA identifier map.
export const STATION_ID_MAP = {};
if (Array.isArray(paradasApi)) {
  for (const p of paradasApi) {
    if (p.nombre && p.id !== undefined) {
      STATION_ID_MAP[p.nombre] = p.id;
      STATION_ID_MAP[p.nombre.toLowerCase().trim()] = p.id;
    }
  }
}
for (const station of (sbahnData.features || []).filter((feature) => feature.geometry.type === 'Point')) {
  const { apiId, name } = station.properties || {};
  if (name && apiId) {
    STATION_ID_MAP[name] = Number(apiId);
    STATION_ID_MAP[name.toLowerCase().trim()] = Number(apiId);
  }
}
const U_BAHN_LINES = new Set(['U1', 'U2', 'U3', 'U4', 'U6']);
const PUBLIC_API_BASE = String(import.meta.env.VITE_VIENNA_API_BASE || '').replace(/\/$/, '');
const LINE_METADATA = new Map(
  [...metroData.features, ...(sbahnData.features || [])]
    .filter((feature) => feature.geometry.type === 'LineString')
    .map((feature) => [feature.properties.line, feature.properties])
);

// Three interchanges cover all five operating Vienna U-Bahn lines.
export const STRATEGIC_HUBS = [
  { id: 60201320, name: 'Stephansplatz', lines: ['U1', 'U3'] },
  { id: 60201182, name: 'Schottenring', lines: ['U2', 'U4'] },
  { id: 60201468, name: 'Westbahnhof', lines: ['U3', 'U6'] },
];

// Distributed reference stations keep every part of every line inside the
// position engine's accurate 18-minute prediction window. They are deliberately
// fixed: opening an arbitrary station panel must never re-anchor map markers.
// The 32 DIVA ids still fit in one monitor request (about 1 MB in practice), so
// a network sweep remains one request every two minutes rather than 99 calls.
export const MAJOR_STATIONS = [
  // U1, south to north
  { id: 60201481, name: 'Neulaa' },
  { id: 60201095, name: 'Reumannplatz' },
  { id: 60200657, name: 'Karlsplatz' },
  { id: 60201040, name: 'Praterstern' },
  { id: 60200031, name: 'Alte Donau' },
  { id: 60201860, name: 'Rennbahnweg' },
  { id: 60201859, name: 'Großfeldsiedlung' },

  // U2, east to centre (shared U1 stations above are not repeated)
  { id: 60200910, name: 'Aspern Nord' },
  { id: 60200299, name: 'Aspernstraße' },
  { id: 60201299, name: 'Stadlau' },
  { id: 60201894, name: 'Stadion' },
  { id: 60201182, name: 'Schottenring' },
  { id: 60201430, name: 'Volkstheater' },

  // U3, west to east
  { id: 60201317, name: 'Kendlerstraße' },
  { id: 60201468, name: 'Westbahnhof' },
  { id: 60201320, name: 'Stephansplatz' },
  { id: 60200743, name: 'Mitte-Landstraße' },
  { id: 60201199, name: 'Schlachthausgasse' },
  { id: 60200425, name: 'Enkplatz' },

  // U4, west to north
  { id: 60200956, name: 'Ober St. Veit' },
  { id: 60200520, name: 'Hietzing' },
  { id: 60200820, name: 'Längenfeldgasse' },
  { id: 60201198, name: 'Schwedenplatz' },
  { id: 60200357, name: 'Friedensbrücke' },
  { id: 60201062, name: 'Spittelau' },

  // U6, south to north (shared U3/U4 stations are not repeated)
  { id: 60201007, name: 'Perfektastraße' },
  { id: 60201499, name: 'Alterlaa' },
  { id: 60201015, name: 'Bhf. Meidling' },
  { id: 60200615, name: 'Josefstädter Straße' },
  { id: 60201510, name: 'Währinger Straße-Volksoper' },
  { id: 60201705, name: 'Handelskai' },
  { id: 60201668, name: 'Neue Donau' },
];

// Only these synchronized reference stations may anchor map positions. A
// station opened in the departure panel is useful to that panel, but mixing an
// arbitrary fresh prediction into the tracking model makes existing markers
// jump to a new anchor at click time.
export const POSITION_SOURCE_IDS = new Set(MAJOR_STATIONS.map((station) => station.id));

// How often a Network Sync sweeps the Major Stations. Long enough to stay well
// inside the upstream rate budget, short enough that no prediction reaches the
// 18-minute age-out before being replaced. It lives here rather than with the
// timer that fires it because it is also the cadence a position's confidence is
// judged against: one interval unheard is healthy, more is not.
export const NETWORK_SYNC_INTERVAL_MS = 120000;

const CACHE_TTL_MS = 60000; // 60 seconds strict memory pause per station
const MIN_REFRESH_COOLDOWN_MS = 30000; // 30 seconds cooldown between manual refreshes
const MIN_DISPATCH_INTERVAL_MS = 1000; // 1 second minimum delay between outbound API requests
const DWELL_GRACE_PERIOD_MS = 40000; // 40 seconds dwell before train rolls off

const parseWienerTimestamp = (value) => {
  if (!value) return NaN;
  // Wiener Linien uses +0200; normalising to +02:00 keeps parsing reliable in
  // WebKit as well as Chromium.
  const normalised = String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  return Date.parse(normalised);
};

const buildMonitorUrl = (stationIds) => {
  const query = stationIds.map((id) => `diva=${encodeURIComponent(id)}`).join('&');
  if (Capacitor.isNativePlatform()) {
    return `https://www.wienerlinien.at/ogd_realtime/monitor?${query}`;
  }
  if (PUBLIC_API_BASE) return `${PUBLIC_API_BASE}/monitor?${query}`;
  return `/api/vienna/monitor?${query}`;
};

const parseMonitorArrivals = (monitors, fetchTime) => {
  const arrivals = monitors.flatMap((monitor) =>
    (monitor.lines || []).flatMap((line) => {
      const lineId = String(line.name || '');
      if (!U_BAHN_LINES.has(lineId)) return [];

      return ((line.departures && line.departures.departure) || []).map((departure) => {
        const timing = departure.departureTime || {};
        const realTimestamp = parseWienerTimestamp(timing.timeReal);
        const plannedTimestamp = parseWienerTimestamp(timing.timePlanned);
        const countdown = Number(timing.countdown);
        const targetTimestamp = Number.isFinite(realTimestamp)
          ? realTimestamp
          : Number.isFinite(plannedTimestamp)
            ? plannedTimestamp
            : fetchTime + (Number.isFinite(countdown) ? countdown * 60000 : 0);
        const vehicle = departure.vehicle || {};
        const destination = vehicle.towards || line.towards || 'Unknown destination';
        const rawDirectionCode = String(vehicle.direction || line.direction || '').toUpperCase();
        const directionCode = rawDirectionCode === 'H' || rawDirectionCode === 'R'
          ? rawDirectionCode
          : null;
        const lineMetadata = LINE_METADATA.get(lineId);
        const lineName = lineMetadata ? lineMetadata.name : lineId;
        const defaultColor = lineMetadata ? lineMetadata.color : '#8a8a8a';
        const lineColor = imageLineColors?.[lineId] || defaultColor;
        const reportedDelaySeconds = Number.isFinite(realTimestamp) && Number.isFinite(plannedTimestamp)
          ? Math.round((realTimestamp - plannedTimestamp) / 1000)
          : null;

        return {
          line: lineId,
          lineName,
          lineColor,
          destination,
          directionCode,
          targetTimestamp,
          plannedTargetTimestamp: Number.isFinite(plannedTimestamp)
            ? plannedTimestamp
            : targetTimestamp,
          // This is the operator's published timeReal - timePlanned value.
          // The train position derived from it remains an inference.
          reportedDelaySeconds,
          delaySource: reportedDelaySeconds === null
            ? null
            : 'wiener-linien-timeReal-minus-timePlanned',
          timingSource: Number.isFinite(realTimestamp)
            ? 'official-wiener-linien-realtime'
            : 'wiener-linien-timetable',
          initialSeconds: Math.max(0, Math.round((targetTimestamp - fetchTime) / 1000)),
          isLive: Boolean(timing.timeReal) && line.realtimeSupported !== false,
          trafficJam: Boolean(vehicle.trafficjam ?? line.trafficjam),
          vehicleId: vehicle.id || vehicle.vehicleId || undefined,
          barrierFree: vehicle.barrierFree ?? line.barrierFree,
        };
      });
    })
  ).filter((arrival) => Number.isFinite(arrival.targetTimestamp));

  // A DIVA query can return the same platform through more than one monitor
  // object. Collapse repeats without merging real trains.
  return [...new Map(arrivals.map((arrival) => [
    `${arrival.line}|${arrival.directionCode || 'unknown'}|${arrival.destination}|${Math.round(arrival.targetTimestamp / 30000)}`,
    arrival,
  ])).values()];
};


class ArrivalStore {
  constructor() {
    this.memory = new Map();
    this.inFlightRequests = new Map();
    this.listeners = new Set();
    this.lastRequestTimestamp = 0;
    this.rateLimitedUntil = 0;
    this.isSeedingHubs = false;
    this.isSyncingNetwork = false;
    this.lastNetworkSyncAt = 0;

    // Hydrate from sessionStorage if available
    this.hydrateFromSessionStorage();
  }

  getStationKey(stationProps) {
    if (!stationProps) return null;
    if (stationProps.apiId) return String(stationProps.apiId);
    const mapped = this.getStationApiId(stationProps);
    if (mapped) return String(mapped);
    return stationProps.name || null;
  }

  getStationApiId(stationProps) {
    if (!stationProps) return null;
    if (stationProps.apiId) return Number(stationProps.apiId);
    if (stationProps.name) {
      const direct = STATION_ID_MAP[stationProps.name];
      if (direct !== undefined) return Number(direct);
      const lower = STATION_ID_MAP[stationProps.name.toLowerCase().trim()];
      if (lower !== undefined) return Number(lower);
    }
    return null;
  }

  hydrateFromSessionStorage() {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      const raw = sessionStorage.getItem('vienna_ubahn_arrival_memory_v5');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const now = Date.now();
      for (const [k, v] of Object.entries(parsed)) {
        if (v && Array.isArray(v.arrivals) && v.arrivals.some(a => (a.targetTimestamp + DWELL_GRACE_PERIOD_MS) > now)) {
          this.memory.set(k, v);
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  persistToSessionStorage() {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      const obj = {};
      const now = Date.now();
      for (const [k, v] of this.memory.entries()) {
        if (v && Array.isArray(v.arrivals) && v.arrivals.some(a => (a.targetTimestamp + DWELL_GRACE_PERIOD_MS) > now)) {
          obj[k] = v;
        }
      }
      sessionStorage.setItem('vienna_ubahn_arrival_memory_v5', JSON.stringify(obj));
    } catch {
      // Ignore storage errors
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    this.listeners.forEach((fn) => {
      try { fn(); } catch { /* ignore */ }
    });
  }

  /**
   * Seeds the network with the minimal 3-hub stations on initial map boot.
   */
  async seedStrategicHubs() {
    if (this.isSeedingHubs) return;
    const now = Date.now();

    // Skip network seeding if memory already contains fresh predictions (< 60s)
    const hasFreshHubs = STRATEGIC_HUBS.every(h => {
      const entry = this.memory.get(String(h.id));
      return entry && (now - entry.fetchedAt) < CACHE_TTL_MS;
    });
    if (hasFreshHubs) return;

    this.isSeedingHubs = true;
    try {
      await this.fetchStationBatch(STRATEGIC_HUBS);
    } catch {
      // The normal station request remains available when batching is refused.
      for (const hub of STRATEGIC_HUBS) {
        await this.getStationArrivals({ apiId: hub.id, name: hub.name });
      }
    } finally {
      this.isSeedingHubs = false;
    }
  }

  /**
   * Fetch several DIVA stations in one Wiener Linien monitor request. The API
   * supports repeated diva parameters, which removes the hosted relay's
   * per-request startup latency while also reducing upstream traffic.
   */
  async fetchStationBatch(stations) {
    if (!Array.isArray(stations) || stations.length === 0) return 0;

    const timeSinceLast = Date.now() - this.lastRequestTimestamp;
    if (timeSinceLast < MIN_DISPATCH_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, MIN_DISPATCH_INTERVAL_MS - timeSinceLast));
    }
    this.lastRequestTimestamp = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(buildMonitorUrl(stations.map((station) => station.id)), {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      if (!response.ok) {
        if (response.status === 429) this.rateLimitedUntil = Date.now() + 20000;
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json().catch(() => null);
      const monitors = data?.data?.monitors;
      if (!Array.isArray(monitors)) throw new Error('Malformed API payload');

      const stationById = new Map(stations.map((station) => [Number(station.id), station]));
      const monitorsByStation = new Map(stations.map((station) => [Number(station.id), []]));
      for (const monitor of monitors) {
        const stationId = Number(monitor.locationStop?.properties?.name);
        if (monitorsByStation.has(stationId)) monitorsByStation.get(stationId).push(monitor);
      }

      const fetchTime = Date.now();
      let updated = 0;
      for (const [stationId, stationMonitors] of monitorsByStation) {
        const station = stationById.get(stationId);
        if (!station || stationMonitors.length === 0) continue;
        this.memory.set(String(stationId), {
          stationId,
          stationName: station.name,
          fetchedAt: fetchTime,
          arrivals: parseMonitorArrivals(stationMonitors, fetchTime),
          fetchError: null,
        });
        updated += 1;
      }

      this.persistToSessionStorage();
      this.notify();
      return updated;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Fetch every Major Station in one pass.
   *
   * Without this the map only ever holds the three boot hubs, so every live
   * train ages out roughly 18 minutes after load and the whole network silently
   * reverts to simulated trains. Stations still inside their memory pause cost
   * no request, so a repeat sync is cheap.
   */
  async syncNetwork() {
    if (this.isSyncingNetwork) return { fetched: 0, skipped: 0 };
    this.isSyncingNetwork = true;

    let fetched = 0;
    let skipped = 0;

    try {
      const staleStations = MAJOR_STATIONS.filter((station) => {
        const entry = this.memory.get(String(station.id));
        if (entry && (Date.now() - entry.fetchedAt) < CACHE_TTL_MS) {
          skipped += 1;
          return false;
        }
        return true;
      });

      try {
        fetched = await this.fetchStationBatch(staleStations);
      } catch {
        // Fall back to individual calls if an intermediary rejects a long URL.
        for (const station of staleStations) {
          const result = await this.getStationArrivals({ apiId: station.id, name: station.name });
          if (!result.fetchError) fetched += 1;
        }
      }
    } finally {
      this.isSyncingNetwork = false;
      this.lastNetworkSyncAt = Date.now();
      this.notify();
    }

    return { fetched, skipped };
  }

  /**
   * Project stored predictions to current wall-clock time
   */
  projectArrivals(entry, now = Date.now()) {
    if (!entry || !Array.isArray(entry.arrivals)) return [];

    const projected = [];
    for (const arr of entry.arrivals) {
      const elapsedSinceTarget = now - arr.targetTimestamp;
      if (elapsedSinceTarget > DWELL_GRACE_PERIOD_MS) {
        continue;
      }

      const remainingSeconds = Math.max(0, Math.round((arr.targetTimestamp - now) / 1000));
      const minutes = Math.max(0, Math.round(remainingSeconds / 60));

      let status = 'On Time';
      if (remainingSeconds <= 0) {
        status = 'At Platform';
      } else if (remainingSeconds <= 120) {
        status = 'Approaching';
      }

      projected.push({
        ...arr,
        seconds: remainingSeconds,
        minutes,
        status,
        targetTimestamp: arr.targetTimestamp,
        isCached: true,
        fetchedAt: entry.fetchedAt,
      });
    }

    return projected.sort((a, b) => a.seconds - b.seconds);
  }

  /**
   * Synchronous check for cached arrival memory (instant render, zero loading spinner)
   */
  getCachedArrivals(stationProps, now = Date.now()) {
    const key = this.getStationKey(stationProps);
    if (!key) return null;
    const entry = this.memory.get(key);
    if (!entry) return null;

    const projected = this.projectArrivals(entry, now);
    if (projected.length === 0) return null;

    const isFresh = (now - entry.fetchedAt) < CACHE_TTL_MS;
    return {
      arrivals: projected,
      isFresh,
      fetchedAt: entry.fetchedAt,
      fetchError: entry.fetchError || null,
    };
  }

  /** Current live arrival predictions across every synchronised reference station. */
  getNetworkArrivals(now = Date.now()) {
    return [...this.memory.values()].flatMap((entry) => this.projectArrivals(entry, now));
  }

  /**
   * Main fetch method with 60s memory pause, rate budgeting, and in-flight deduplication.
   */
  async getStationArrivals(stationProps, { forceRefresh = false } = {}) {
    if (!stationProps) return [];
    const key = this.getStationKey(stationProps);
    const stationId = this.getStationApiId(stationProps);
    const now = Date.now();

    const entry = key ? this.memory.get(key) : null;
    const timeSinceFetch = entry ? (now - entry.fetchedAt) : Infinity;

    // 1. Strict 60-Second Memory Pause:
    // If fetched less than 60s ago, NEVER make a network call (return memory data).
    if (entry && !forceRefresh && timeSinceFetch < CACHE_TTL_MS) {
      const projected = this.projectArrivals(entry, now);
      return Object.assign(projected, {
        isFromCache: true,
        fetchedAt: entry.fetchedAt,
        fetchError: entry.fetchError || null,
      });
    }

    // 2. Manual Refresh Cooldown:
    // Even if user clicks Refresh, enforce a 30s pause to prevent button spamming.
    if (entry && forceRefresh && timeSinceFetch < MIN_REFRESH_COOLDOWN_MS) {
      const projected = this.projectArrivals(entry, now);
      return Object.assign(projected, {
        isFromCache: true,
        fetchedAt: entry.fetchedAt,
        fetchError: 'Refreshed recently. Showing countdown from memory.',
      });
    }

    // 3. If no API endpoint exists for this station, return empty with notice
    if (!stationId) {
      return Object.assign([], {
        fetchError: 'N/A — this station has no live prediction endpoint.',
        isFromCache: false,
        fetchedAt: now,
      });
    }

    // 4. Deduplicate in-flight requests for the same station
    if (this.inFlightRequests.has(key)) {
      return this.inFlightRequests.get(key);
    }

    // 5. Rate-limit backoff check
    if (this.rateLimitedUntil > now && !forceRefresh) {
      if (entry) {
        const projected = this.projectArrivals(entry, now);
        return Object.assign(projected, {
          isFromCache: true,
          fetchedAt: entry.fetchedAt,
          fetchError: 'Live rate limit active. Counting down from previous sync.',
        });
      }
    }

    // Create execution promise
    const fetchPromise = (async () => {
      // Respect dispatch pacing between requests
      const timeSinceLast = Date.now() - this.lastRequestTimestamp;
      if (timeSinceLast < MIN_DISPATCH_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, MIN_DISPATCH_INTERVAL_MS - timeSinceLast));
      }
      this.lastRequestTimestamp = Date.now();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9000);

      try {
        const response = await fetch(buildMonitorUrl([stationId]), {
          signal: controller.signal,
          headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
          if (response.status === 429) {
            this.rateLimitedUntil = Date.now() + 20000; // 20s backoff
          }
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json().catch(() => null);
        const monitors = data && data.data && Array.isArray(data.data.monitors)
          ? data.data.monitors
          : null;
        if (monitors) {
          const fetchTime = Date.now();
          const parsedArrivals = parseMonitorArrivals(monitors, fetchTime);

          // Store in memory
          const updatedEntry = {
            stationId,
            stationName: stationProps.name,
            fetchedAt: fetchTime,
            arrivals: parsedArrivals,
            fetchError: null,
          };
          this.memory.set(key, updatedEntry);
          this.persistToSessionStorage();
          this.notify();

          const projected = this.projectArrivals(updatedEntry, fetchTime);
          return Object.assign(projected, {
            isFromCache: false,
            fetchedAt: fetchTime,
            fetchError: null,
          });
        }

        throw new Error('Malformed API payload');
      } catch {
        // Resilient Fallback: If network/rate limit failed, check if we have prior memory!
        const existingEntry = this.memory.get(key);
        if (existingEntry) {
          const projected = this.projectArrivals(existingEntry, Date.now());
          if (projected.length > 0) {
            return Object.assign(projected, {
              isFromCache: true,
              fetchedAt: existingEntry.fetchedAt,
              fetchError: 'Live update paused (rate limit). Showing countdown from earlier sync.',
            });
          }
        }

        // No prior memory
        return Object.assign([], {
          fetchError: 'Live predictions are currently unavailable.',
          isFromCache: false,
          fetchedAt: Date.now(),
        });
      } finally {
        clearTimeout(timeoutId);
        this.inFlightRequests.delete(key);
      }
    })();

    this.inFlightRequests.set(key, fetchPromise);
    return fetchPromise;
  }
}

export const arrivalStore = new ArrivalStore();
export default arrivalStore;

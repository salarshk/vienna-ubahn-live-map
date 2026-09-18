// 50 x 50 metre spatial intelligence for the Vienna network.
//
// A cell is deliberately a reporting unit, not a claim that a train has a
// continuous GPS fix.  Most Wiener Linien positions are inferred from live
// departure predictions; every derived metric keeps that distinction visible.
import gtfsData from '../data/gtfs_expanded.json';
import sbahnData from '../data/sbahn_network.json';
import tramData from '../data/tram_network.json';
import { persistBrowserArchive, readBrowserArchive } from './browserArchive';

export const GRID_SIZE_METRES = 50;
export const GRID_KEY = 'vienna_cell_intelligence_v1';
const LATITUDE_METRES = 111320;
const VIENNA_LATITUDE = 48.2082;
const LONGITUDE_METRES = LATITUDE_METRES * Math.cos(VIENNA_LATITUDE * Math.PI / 180);
const ORIGIN = [16.1, 47.9];

const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0));
const normalise = (value) => String(value || '').toLocaleLowerCase('de-AT').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const stationFeatures = [
  ...(gtfsData?.features || []),
  ...(sbahnData?.features || []),
  ...(tramData?.features || []),
].filter((feature) => feature?.geometry?.type === 'Point' && Array.isArray(feature.geometry.coordinates));

const stations = [...new Map(stationFeatures.map((feature) => {
  const p = feature.properties || {};
  return [normalise(p.name), {
    name: p.name || 'Unknown station',
    coordinates: feature.geometry.coordinates.slice(0, 2).map(Number),
    lines: [...new Set((p.lines || []).map(String).filter(Boolean))],
    mode: p.mode || (String(p.lines?.[0] || '').startsWith('S') ? 'sbahn' : String(p.lines?.[0] || '').match(/^\d/) ? 'tram' : 'ubahn'),
  }];
}).filter(([key]) => key))].map(([, station]) => station);

const stationByName = new Map(stations.map((station) => [normalise(station.name), station]));

export const coordinatesToCell = (coordinates) => {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const x = Math.floor((longitude - ORIGIN[0]) * LONGITUDE_METRES / GRID_SIZE_METRES);
  const y = Math.floor((latitude - ORIGIN[1]) * LATITUDE_METRES / GRID_SIZE_METRES);
  const west = ORIGIN[0] + x * GRID_SIZE_METRES / LONGITUDE_METRES;
  const south = ORIGIN[1] + y * GRID_SIZE_METRES / LATITUDE_METRES;
  return {
    id: `${x}:${y}`,
    x,
    y,
    center: [west + GRID_SIZE_METRES / 2 / LONGITUDE_METRES, south + GRID_SIZE_METRES / 2 / LATITUDE_METRES],
    bounds: [west, south, west + GRID_SIZE_METRES / LONGITUDE_METRES, south + GRID_SIZE_METRES / LATITUDE_METRES],
  };
};

export const cellPolygon = (cell) => {
  if (!cell?.bounds) return [];
  const [west, south, east, north] = cell.bounds;
  return [[west, south], [east, south], [east, north], [west, north], [west, south]];
};

const distanceMetres = (a, b) => {
  if (!a || !b) return Infinity;
  const dx = (Number(a[0]) - Number(b[0])) * LONGITUDE_METRES;
  const dy = (Number(a[1]) - Number(b[1])) * LATITUDE_METRES;
  return Math.sqrt(dx * dx + dy * dy);
};

const newCell = (cell) => ({
  ...cell,
  lines: new Set(),
  modes: new Set(),
  stations: new Set(),
  trainIds: new Set(),
  delays: [],
  delayTrends: [],
  arrivalCount: 0,
  liveTrainCount: 0,
  scheduledTrainCount: 0,
  exactGpsCount: 0,
  inferredPositionCount: 0,
  headwayRisk: 0,
  gapRisk: 0,
  bunchingRisk: 0,
  dwellRisk: 0,
  disruptionCount: 0,
  accessibilityIssues: 0,
  trafficJamSignals: 0,
  transferLines: new Set(),
  nearestStation: null,
  userDistanceMetres: null,
});

const addDelay = (cell, value) => {
  const delay = finite(value);
  if (delay !== null) cell.delays.push(delay);
};

const addLine = (cell, line, mode = null) => {
  if (!line) return;
  cell.lines.add(String(line));
  if (mode) cell.modes.add(mode);
  else cell.modes.add(String(line).startsWith('S') ? 'sbahn' : String(line).match(/^\d/) ? 'tram' : 'ubahn');
};

const findStationCell = (name) => {
  const station = stationByName.get(normalise(name));
  return station ? { station, cell: coordinatesToCell(station.coordinates) } : null;
};

const toCellList = (cells) => [...cells.values()].map((cell) => {
  const delays = cell.delays;
  const meanDelay = delays.length ? delays.reduce((sum, value) => sum + value, 0) / delays.length : 0;
  const delayTrend = cell.delayTrends.length ? cell.delayTrends.reduce((sum, value) => sum + value, 0) / cell.delayTrends.length : 0;
  const maxDelay = delays.length ? Math.max(...delays) : 0;
  const lines = [...cell.lines].sort();
  const stationNames = [...cell.stations].sort();
  const transferProbability = lines.length > 1
    ? clamp(92 - Math.max(0, meanDelay) * 3 - cell.bunchingRisk * 0.35 - cell.gapRisk * 0.2)
    : null;
  const crowdPressure = clamp(
    cell.liveTrainCount * 10 + cell.arrivalCount * 1.5 + cell.gapRisk * 0.35
      + cell.bunchingRisk * 0.45 + Math.max(0, meanDelay) * 2 + cell.disruptionCount * 12,
  );
  const reliability = clamp(100 - Math.max(0, meanDelay) * 8 - cell.gapRisk * 0.3 - cell.bunchingRisk * 0.2 - cell.disruptionCount * 12);
  const delayForecast = Math.max(0, meanDelay / 60 + Math.max(0, delayTrend) * 2 + cell.gapRisk / 180 + cell.bunchingRisk / 240);
  const recoveryMinutes = cell.disruptionCount || cell.gapRisk || cell.bunchingRisk
    ? Math.max(1, Math.round(2 + Math.max(0, meanDelay) / 60 + cell.gapRisk / 240 + cell.bunchingRisk / 300))
    : 0;
  const severity = delayForecast >= 5 || crowdPressure >= 75 ? 'high' : delayForecast >= 2 || crowdPressure >= 45 ? 'medium' : 'low';
  const confidence = cell.exactGpsCount > 0
    ? clamp(70 + Math.min(30, cell.exactGpsCount * 8))
    : clamp(35 + Math.min(35, cell.inferredPositionCount * 3));

  return {
    ...cell,
    lines,
    modes: [...cell.modes].sort(),
    stations: stationNames,
    trainIds: [...cell.trainIds],
    observations: cell.delays.length + cell.arrivalCount + cell.liveTrainCount,
    meanDelaySeconds: Math.round(meanDelay),
    maxDelaySeconds: Math.round(maxDelay),
    delayTrendMinutesPerHour: Number((delayTrend).toFixed(2)),
    delayForecastMinutes: Number(delayForecast.toFixed(1)),
    recoveryMinutes,
    crowdPressure: Math.round(crowdPressure),
    reliability: Math.round(reliability),
    transferProbability: transferProbability == null ? null : Math.round(transferProbability),
    confidence: Math.round(confidence),
    severity,
    riskScore: Math.round(clamp(100 - reliability + crowdPressure * 0.35 + cell.dwellRisk * 0.2)),
    coverage: lines.length ? Math.round(clamp(35 + lines.length * 20 + (cell.arrivalCount ? 20 : 0))) : 0,
    environmental: cell.environmental || null,
    displayName: stationNames[0] || (lines.length ? `${lines.join(' · ')} corridor` : 'Network cell'),
    geometry: { type: 'Polygon', coordinates: [cellPolygon(cell)] },
  };
});

export const buildCellIntelligence = ({
  vehicles = [], entries = [], issues = [], disruptions = [], context = {}, userLocation = null, now = Date.now(),
} = {}) => {
  const cells = new Map();
  const ensure = (coordinates) => {
    const base = coordinatesToCell(coordinates);
    if (!base) return null;
    if (!cells.has(base.id)) cells.set(base.id, newCell(base));
    return cells.get(base.id);
  };
  const addStation = (station) => {
    const cell = ensure(station.coordinates);
    if (!cell) return null;
    cell.stations.add(station.name);
    station.lines.forEach((line) => addLine(cell, line, station.mode));
    if (!cell.nearestStation || distanceMetres(cell.center, station.coordinates) < cell.nearestStation.distanceMetres) {
      cell.nearestStation = { name: station.name, distanceMetres: Math.round(distanceMetres(cell.center, station.coordinates)), lines: station.lines };
    }
    return cell;
  };

  // Include the static station cells so the grid also describes service
  // coverage, accessibility and transfer locations when no train is present.
  stations.forEach(addStation);

  vehicles.forEach((vehicle) => {
    const cell = ensure(vehicle.coordinates);
    if (!cell) return;
    const mode = String(vehicle.line || '').startsWith('S') ? 'sbahn' : String(vehicle.line || '').match(/^\d/) ? 'tram' : 'ubahn';
    addLine(cell, vehicle.line, mode);
    cell.trainIds.add(String(vehicle.id || `${vehicle.line}-${vehicle.direction || ''}`));
    if (vehicle.isLive) cell.liveTrainCount += 1;
    if (vehicle.isScheduled) cell.scheduledTrainCount += 1;
    if (vehicle.exactGpsAvailable || vehicle.positionSource === 'official-vehicle-gps') cell.exactGpsCount += 1;
    else cell.inferredPositionCount += 1;
    addDelay(cell, vehicle.officialDelaySeconds);
    if (vehicle.isDeadReckoned || vehicle.sourceFreshness === 'stale') cell.positionStale = true;
  });

  entries.forEach((entry) => {
    const found = findStationCell(entry.stationName);
    if (!found?.cell) return;
    const cell = addStation(found.station);
    if (!cell) return;
    const fresh = Number.isFinite(Number(entry.fetchedAt)) && now - Number(entry.fetchedAt) <= 5 * 60 * 1000;
    (entry.arrivals || []).forEach((arrival) => {
      addLine(cell, arrival.line);
      if (fresh && arrival.isLive !== false) cell.arrivalCount += 1;
      addDelay(cell, arrival.reportedDelaySeconds);
      const trend = finite(arrival.delayTrendMinutes);
      if (trend !== null) cell.delayTrends.push(trend);
      if (arrival.onStop === true) cell.dwellRisk = Math.max(cell.dwellRisk, 35 + Math.max(0, finite(arrival.reportedDelaySeconds, 0)) / 6);
      if (arrival.trafficJam) cell.trafficJamSignals += 1;
    });
  });

  issues.forEach((issue) => {
    const found = findStationCell(issue.station);
    if (!found) return;
    const cell = addStation(found.station);
    const seconds = finite(issue.seconds, 0);
    if (issue.type === 'gap') cell.gapRisk = Math.max(cell.gapRisk, clamp(100 - seconds / 5));
    if (issue.type === 'bunch') cell.bunchingRisk = Math.max(cell.bunchingRisk, clamp(100 - seconds / 1.2));
    addLine(cell, issue.line);
  });

  disruptions.forEach((disruption) => {
    const found = findStationCell(disruption.station || disruption.location);
    if (!found) return;
    const cell = addStation(found.station);
    cell.disruptionCount += 1;
    if (disruption.isElevator || disruption.category === 'accessibility') cell.accessibilityIssues += 1;
    (disruption.lines || []).forEach((line) => addLine(cell, line));
  });

  const weather = context.weatherNowcast || context.weather || null;
  const air = context.airQuality || null;
  const bike = context.bikeShare || null;
  const environmental = weather || air || bike ? {
    weather: weather?.description || null,
    temperature: finite(weather?.temperature),
    precipitation: finite(weather?.next60MinPrecipitation ?? weather?.precipitation),
    windSpeed: finite(weather?.windSpeed),
    pm10: finite(air?.pm10),
    availableBikes: finite(bike?.availableBikes),
  } : null;
  cells.forEach((cell) => { cell.environmental = environmental; });

  const userCell = userLocation?.status === 'located' ? coordinatesToCell(userLocation.coordinates) : null;
  if (userCell) {
    const userCoordinates = userLocation.coordinates;
    cells.forEach((cell) => { cell.userDistanceMetres = Math.round(distanceMetres(userCoordinates, cell.center)); });
  }

  const result = toCellList(cells)
    .filter((cell) => cell.lines.length || cell.stations.length || cell.liveTrainCount || cell.arrivalCount)
    .sort((a, b) => b.riskScore - a.riskScore || b.meanDelaySeconds - a.meanDelaySeconds);
  return {
    generatedAt: now,
    cellSizeMetres: GRID_SIZE_METRES,
    cells: result,
    nearestUserCell: userCell ? result.find((cell) => cell.id === userCell.id) || null : null,
    rankings: {
      delay: result.filter((cell) => cell.meanDelaySeconds > 0).slice().sort((a, b) => b.meanDelaySeconds - a.meanDelaySeconds),
      crowd: result.slice().sort((a, b) => b.crowdPressure - a.crowdPressure),
      reliability: result.slice().sort((a, b) => a.reliability - b.reliability),
      recovery: result.slice().sort((a, b) => b.recoveryMinutes - a.recoveryMinutes),
      access: result.filter((cell) => cell.accessibilityIssues > 0),
    },
  };
};

export const cellsToGeoJSON = (cells = [], visible = true) => ({
  type: 'FeatureCollection',
  features: visible ? cells.map((cell) => ({
    type: 'Feature',
    geometry: cell.geometry,
    properties: {
      id: cell.id,
      severity: cell.severity,
      delay: cell.meanDelaySeconds,
      risk: cell.riskScore,
      pressure: cell.crowdPressure,
    },
  })) : [],
});

// Compact hourly/daily/weekly/monthly/yearly cell reports. This store is a
// bounded aggregate archive; raw five-second positions are never persisted.
const PERIODS = {
  hourly: { retention: 24 * 14, key: (date) => date.toISOString().slice(0, 13) },
  daily: { retention: 370, key: (date) => date.toISOString().slice(0, 10) },
  weekly: { retention: 110, key: (date) => { const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); const day = copy.getUTCDay() || 7; copy.setUTCDate(copy.getUTCDate() - day + 1); return copy.toISOString().slice(0, 10); } },
  monthly: { retention: 72, key: (date) => date.toISOString().slice(0, 7) },
  yearly: { retention: 10, key: (date) => date.toISOString().slice(0, 4) },
};

const emptyReportState = () => ({ version: 1, lastRecordedAt: 0, buckets: Object.fromEntries(Object.keys(PERIODS).map((period) => [period, {}])) });
const readLocal = () => { try { const value = JSON.parse(localStorage.getItem(GRID_KEY) || 'null'); return value?.buckets ? value : null; } catch { return null; } };
const aggregateCell = (collection, cell, at) => {
  const current = collection[cell.id] || { id: cell.id, samples: 0, riskSum: 0, delaySum: 0, pressureSum: 0, maxDelay: 0, lastObservedAt: 0, name: cell.displayName, center: cell.center };
  current.samples += 1;
  current.riskSum += Number(cell.riskScore) || 0;
  current.delaySum += Number(cell.meanDelaySeconds) || 0;
  current.pressureSum += Number(cell.crowdPressure) || 0;
  current.maxDelay = Math.max(current.maxDelay, Number(cell.maxDelaySeconds) || 0);
  current.lastObservedAt = at;
  collection[cell.id] = current;
};

class GridReportStore {
  constructor() {
    this.state = readLocal() || emptyReportState();
    this.listeners = new Set();
    void readBrowserArchive(GRID_KEY).then((stored) => { if (stored?.buckets) { this.state = stored; this.notify(); } });
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() { this.listeners.forEach((listener) => { try { listener(this.getSnapshot()); } catch { /* consumer errors do not stop storage */ } }); }
  record(cells = [], at = Date.now()) {
    if (at - Number(this.state.lastRecordedAt || 0) < 5 * 60 * 1000 || !cells.length) return false;
    Object.entries(PERIODS).forEach(([period, config]) => {
      const key = config.key(new Date(at));
      const bucket = this.state.buckets[period][key] || { at, cells: {} };
      cells.forEach((cell) => aggregateCell(bucket.cells, cell, at));
      bucket.at = Math.min(Number(bucket.at) || at, at);
      this.state.buckets[period][key] = bucket;
      const keys = Object.keys(this.state.buckets[period]).sort().slice(-config.retention);
      this.state.buckets[period] = Object.fromEntries(keys.map((item) => [item, this.state.buckets[period][item]]));
    });
    this.state.lastRecordedAt = at;
    try { localStorage.setItem(GRID_KEY, JSON.stringify(this.state)); } catch { /* IndexedDB remains the full archive */ }
    void persistBrowserArchive(GRID_KEY, this.state);
    this.notify();
    return true;
  }
  getReport(period = 'daily') {
    const buckets = this.state.buckets[PERIODS[period] ? period : 'daily'] || {};
    const cells = new Map();
    Object.values(buckets).forEach((bucket) => Object.values(bucket.cells || {}).forEach((item) => {
      const current = cells.get(item.id) || { ...item, samples: 0, riskSum: 0, delaySum: 0, pressureSum: 0, maxDelay: 0 };
      current.samples += item.samples || 0;
      current.riskSum += item.riskSum || 0;
      current.delaySum += item.delaySum || 0;
      current.pressureSum += item.pressureSum || 0;
      current.maxDelay = Math.max(current.maxDelay, item.maxDelay || 0);
      cells.set(item.id, current);
    }));
    return [...cells.values()].map((cell) => ({ ...cell, meanRisk: Math.round(cell.riskSum / Math.max(1, cell.samples)), meanDelaySeconds: Math.round(cell.delaySum / Math.max(1, cell.samples)), meanPressure: Math.round(cell.pressureSum / Math.max(1, cell.samples)) })).sort((a, b) => b.meanRisk - a.meanRisk);
  }
  getSnapshot() { return { lastRecordedAt: this.state.lastRecordedAt || null, buckets: Object.fromEntries(Object.entries(this.state.buckets).map(([period, values]) => [period, Object.keys(values).length])) }; }
}

export const gridReportStore = new GridReportStore();
export const GRID_REPORT_PERIODS = Object.keys(PERIODS);
export default buildCellIntelligence;

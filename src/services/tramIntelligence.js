import tramData from '../data/tram_network.json';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 1) => Number(Number(value).toFixed(digits));

export const TRAM_LINES = (tramData.features || [])
  .filter((feature) => feature.geometry?.type === 'LineString')
  .map((feature) => String(feature.properties?.line))
  .filter(Boolean);

const metadata = new Map((tramData.features || [])
  .filter((feature) => feature.geometry?.type === 'LineString')
  .map((feature) => [String(feature.properties.line), feature.properties]));

const liveArrivalsFor = (arrivals, line) => arrivals
  .filter((arrival) => arrival?.isLive && String(arrival.line) === line && Number.isFinite(Number(arrival.seconds)))
  .sort((a, b) => Number(a.seconds) - Number(b.seconds));

const headwayFor = (arrivals) => {
  const byStation = new Map();
  arrivals.forEach((arrival) => {
    const key = String(arrival.stationName || arrival.stationId || 'network');
    const values = byStation.get(key) || [];
    values.push(Number(arrival.seconds));
    byStation.set(key, values);
  });
  let largest = { seconds: 0, station: null };
  let closest = { seconds: Infinity, station: null };
  for (const [station, values] of byStation) {
    const ordered = values.sort((a, b) => a - b);
    for (let index = 1; index < ordered.length; index += 1) {
      const gap = ordered[index] - ordered[index - 1];
      if (gap > largest.seconds) largest = { seconds: gap, station };
      if (gap < closest.seconds) closest = { seconds: gap, station };
    }
  }
  return {
    largestGapMinutes: largest.seconds ? round(largest.seconds / 60) : null,
    largestGapStation: largest.station,
    closestPairMinutes: Number.isFinite(closest.seconds) ? round(closest.seconds / 60) : null,
    closestPairStation: closest.station,
  };
};

/**
 * Tram-specific transparent baselines. Street-running trams are exposed to
 * traffic and signal delay, so this keeps separate outputs from the U-Bahn
 * model instead of pretending their operating conditions are interchangeable.
 */
export const buildTramPredictions = ({ arrivals = [], vehicles = [], issues = [], disruptions = [], now = Date.now() } = {}) => TRAM_LINES.map((line) => {
  const lineArrivals = liveArrivalsFor(arrivals, line);
  const lineVehicles = vehicles.filter((vehicle) => vehicle?.isLive && String(vehicle.line) === line);
  const delays = lineArrivals.map((arrival) => Number(arrival.reportedDelaySeconds) / 60).filter(Number.isFinite);
  const meanDelay = delays.length ? delays.reduce((sum, value) => sum + value, 0) / delays.length : 0;
  const headway = headwayFor(lineArrivals);
  const lineIssues = issues.filter((issue) => String(issue.line) === line);
  const lineDisruptions = disruptions.filter((item) => (item.lines || []).map(String).includes(line));
  const pressure = clamp(Math.round(
    22 + Math.min(36, lineArrivals.filter((arrival) => arrival.seconds <= 600).length * 6)
      + Math.min(24, meanDelay * 5)
      + lineIssues.filter((issue) => issue.type === 'gap').length * 12
      + lineIssues.filter((issue) => issue.type === 'bunch').length * 8
      + lineDisruptions.length * 24,
  ), 0, 99);
  const impact = clamp(Math.round(
    lineDisruptions.length * 45 + lineIssues.length * 18 + Math.max(0, meanDelay) * 8,
  ), 0, 99);
  const confidence = clamp(Math.round(28 + (lineArrivals.length ? 30 : 0) + Math.min(28, lineVehicles.length * 8) + (delays.length ? 10 : 0)), 15, 90);
  return {
    line,
    name: metadata.get(line)?.name || `Tram ${line}`,
    mode: 'tram',
    meanDelayMinutes: round(meanDelay),
    nextMinutes: lineArrivals[0] ? round(Number(lineArrivals[0].seconds) / 60) : null,
    liveArrivals: lineArrivals.length,
    liveVehicles: lineVehicles.length,
    pressure,
    pressureLevel: pressure >= 70 ? 'high' : pressure >= 45 ? 'watch' : 'routine',
    impact,
    impactLevel: impact >= 70 ? 'high' : impact >= 35 ? 'watch' : 'routine',
    headway,
    confidence,
    evidence: lineArrivals.length
      ? `${lineArrivals.length} live departure${lineArrivals.length === 1 ? '' : 's'} · street-running baseline`
      : 'No live departure observation in the current sweep',
    generatedAt: now,
  };
});

export const summariseTramPredictions = (predictions = []) => ({
  lines: predictions.length,
  liveLines: predictions.filter((item) => item.liveArrivals > 0).length,
  highPressure: predictions.filter((item) => item.pressureLevel === 'high').length,
  disrupted: predictions.filter((item) => item.impactLevel === 'high').length,
});

export default buildTramPredictions;

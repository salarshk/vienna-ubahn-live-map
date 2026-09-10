import { estimateConnections } from './networkIntelligence';
import { LINES } from './transitModels';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 0) => Number(Number(value).toFixed(digits));

export const buildEtaUncertainty = (vehicles = []) => vehicles
  .filter((vehicle) => vehicle?.isLive && String(vehicle.line).startsWith('U') && Number.isFinite(vehicle.secondsToTarget))
  .map((vehicle) => {
    const uncertainty = clamp(Number(vehicle.positionUncertaintyMetres) || 250, 120, 1200);
    const timeUncertainty = clamp(Math.round(uncertainty / 75), 1, 8);
    const eta = Math.max(0, Math.round(vehicle.secondsToTarget / 60));
    return {
      id: vehicle.id,
      line: vehicle.line,
      destination: vehicle.destination,
      station: vehicle.targetStation,
      eta,
      low: Math.max(0, eta - timeUncertainty),
      high: eta + timeUncertainty,
      confidence: clamp(Number(vehicle.positionConfidence) || Math.round(100 - uncertainty / 12), 10, 98),
    };
  })
  .sort((a, b) => b.high - a.high)
  .slice(0, 8);

export const buildTransferHealth = (vehicles = [], now = Date.now()) => vehicles
  .filter((vehicle) => vehicle?.isLive && vehicle.targetStation)
  .flatMap((vehicle) => estimateConnections(vehicle, now).map((connection) => ({
    from: vehicle.line,
    to: connection.line,
    station: connection.station,
    destination: connection.destination,
    probability: connection.probability,
    rating: connection.rating,
    marginMinutes: round(connection.marginSeconds / 60, 1),
  })))
  .sort((a, b) => a.probability - b.probability)
  .filter((item, index, all) => all.findIndex((candidate) => (
    candidate.from === item.from && candidate.to === item.to && candidate.station === item.station
  )) === index)
  .slice(0, 8);

export const buildRecoveryForecast = ({ issues = [], forecasts = [], reliability = [] } = {}) => LINES.map((line) => {
  const lineIssues = issues.filter((issue) => issue.line === line);
  const risks = forecasts.flatMap((forecast) => forecast.lines.filter((item) => item.line === line).map((item) => item.risk));
  const maxRisk = Math.max(0, ...risks);
  const maxSeverity = Math.max(0, ...lineIssues.map((issue) => Number(issue.severity) || 0));
  const observedReliability = reliability.find((item) => item.line === line);
  if (!lineIssues.length && !maxRisk) return {
    line, status: 'stable', window: 'No recovery signal', confidence: 35,
  };
  const minutes = clamp(Math.round(8 + maxSeverity / 45 + maxRisk / 20), 10, 45);
  return {
    line, status: maxRisk >= 70 || maxSeverity >= 300 ? 'watch' : 'monitor',
    window: `about ${minutes}–${minutes + 10} min`, confidence: clamp(
      45 + (observedReliability?.observations >= 3 ? 15 : 0), 25, 75
    ),
  };
});

export const buildRouteRisk = ({ recovery = [], pressure = [], reliability = [] } = {}) => {
  const scored = LINES.map((line) => {
    const recoveryItem = recovery.find((item) => item.line === line);
    const pressureItem = pressure.find((item) => item.line === line);
    const reliabilityItem = reliability.find((item) => item.line === line);
    const risk = (recoveryItem?.status === 'watch' ? 45 : recoveryItem?.status === 'monitor' ? 20 : 0)
      + (pressureItem?.level === 'high' ? 30 : pressureItem?.level === 'medium' ? 15 : 0)
      + (Number.isFinite(reliabilityItem?.score) && reliabilityItem.score < 50 ? 20 : 0);
    return { line, risk: clamp(risk, 0, 95), level: risk >= 60 ? 'high' : risk >= 30 ? 'medium' : 'low' };
  });
  return scored.map((item) => ({
    ...item,
    alternative: [...scored].filter((candidate) => candidate.line !== item.line)
      .sort((a, b) => a.risk - b.risk)[0]?.line || null,
  }));
};

export const buildStationSignals = (issues = []) => [...issues.reduce((groups, issue) => {
  const key = issue.station || 'Unknown station';
  const current = groups.get(key) || { station: key, lines: new Set(), gaps: 0, bunches: 0 };
  current.lines.add(issue.line);
  if (issue.type === 'gap') current.gaps += 1;
  if (issue.type === 'bunch') current.bunches += 1;
  groups.set(key, current);
  return groups;
}, new Map()).values()].map((item) => ({
  ...item, lines: [...item.lines], score: item.gaps * 2 + item.bunches,
})).sort((a, b) => b.score - a.score).slice(0, 6);

export const buildDwellSignals = (vehicles = []) => vehicles
  .filter((vehicle) => vehicle?.isLive && vehicle.status === 'At Platform' && Number(vehicle.secondsUnheard) >= 120)
  .map((vehicle) => ({
    line: vehicle.line, station: vehicle.targetStation || 'unknown station',
    minutes: round(Number(vehicle.secondsUnheard) / 60, 1),
  })).slice(0, 6);

export const buildDirectionSignals = (vehicles = []) => vehicles
  .filter((vehicle) => vehicle?.isLive && String(vehicle.line).startsWith('U'))
  .map((vehicle) => ({
    line: vehicle.line, destination: vehicle.destination,
    confidence: clamp(Number(vehicle.positionConfidence) || 0, 0, 100),
    direction: vehicle.isForward === false ? 'reverse track' : 'forward track',
    station: vehicle.targetStation,
  }))
  .filter((item) => item.confidence < 65)
  .sort((a, b) => a.confidence - b.confidence).slice(0, 6);

export const buildCalendarPressure = (now = Date.now(), crowding = []) => {
  const date = new Date(now);
  const hour = date.getHours() + date.getMinutes() / 60;
  const weekday = date.getDay();
  const peak = weekday >= 1 && weekday <= 5 && ((hour >= 7 && hour <= 9.5) || (hour >= 16 && hour <= 19));
  return crowding.map((item) => ({
    ...item,
    outlook: peak ? 'Elevated next 60 min' : item.level === 'high' ? 'Elevated from service pattern' : 'Routine',
    source: peak ? 'weekday peak calendar + service pattern' : 'service pattern only',
  }));
};

export const buildCauseSignals = ({ line, issues = [], disruptions = [], crowding = [], forecasts = [] } = {}) => {
  const signals = [];
  issues.filter((issue) => issue.line === line).forEach((issue) => signals.push({
    label: issue.type === 'gap' ? 'Predicted service gap' : 'Predicted bunching',
    detail: `${issue.label} at ${issue.station}`,
  }));
  disruptions.filter((incident) => incident.lines?.includes(line)).slice(0, 2).forEach((incident) => signals.push({
    label: 'Official notice', detail: incident.title,
  }));
  const pressure = crowding.find((item) => item.line === line);
  if (pressure) signals.push({ label: 'Pressure proxy', detail: `${pressure.level} · ${pressure.reason}` });
  const forecast = forecasts.find((item) => item.lines.some((item) => item.line === line));
  if (forecast) signals.push({ label: 'Propagation risk', detail: `risk remains visible at +${forecast.minutes} min` });
  return signals.slice(0, 6);
};

export const simulateNetworkScenario = ({ line = 'U1', extraMinutes = 15, issues = [], forecasts = [] } = {}) => {
  const seed = issues.filter((issue) => issue.line === line).length ? 70 : 30;
  return forecasts.map((forecast) => ({
    minutes: forecast.minutes,
    risk: clamp(Math.round(seed * Math.max(0.25, 1 - forecast.minutes / 120) + extraMinutes * 1.5), 0, 99),
    lines: forecast.lines.slice(0, 5).map((item) => item.line),
  }));
};

export const buildDataQuality = ({ now = Date.now(), entries = [], vehicles = [], sbahnFreshness = null } = {}) => {
  const freshEntries = entries.filter((entry) => Number.isFinite(entry?.fetchedAt) && now - entry.fetchedAt <= 5 * 60 * 1000);
  const liveArrivals = entries.reduce((sum, entry) => sum + (entry?.arrivals || []).filter((item) => item.isLive).length, 0);
  const staleEntries = entries.length - freshEntries.length;
  const confidence = clamp(Math.round(100 * (freshEntries.length / Math.max(1, entries.length)) * 0.65
    + Math.min(1, liveArrivals / 30) * 25 + (vehicles.some((vehicle) => vehicle.isLive) ? 10 : 0)), 0, 100);
  return {
    confidence, freshStations: freshEntries.length, totalStations: entries.length,
    liveArrivals, liveVehicles: vehicles.filter((vehicle) => vehicle.isLive).length,
    staleEntries, sbahn: sbahnFreshness?.status || 'unknown',
  };
};

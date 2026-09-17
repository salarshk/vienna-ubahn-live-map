import gtfsData from '../data/gtfs_expanded.json';
import sbahnData from '../data/sbahn_network.json';
import { estimateConnections } from './networkIntelligence';

const U_LINES = new Set(['U1', 'U2', 'U3', 'U4', 'U6']);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const normalise = (value) => clean(value).toLocaleLowerCase('de-AT');

const stationMap = new Map();
for (const feature of [
  ...(gtfsData.features || []),
  ...(sbahnData.features || []),
].filter((item) => item.geometry?.type === 'Point')) {
  const name = clean(feature.properties?.name);
  if (!name) continue;
  const existing = stationMap.get(normalise(name));
  const lines = [...new Set([
    ...(existing?.lines || []),
    ...(feature.properties?.lines || []),
  ].map(String).filter(Boolean))].sort();
  stationMap.set(normalise(name), { name, lines });
}

export const JOURNEY_STATIONS = [...stationMap.values()]
  .filter((station) => station.lines.some((line) => U_LINES.has(line)))
  .sort((a, b) => a.name.localeCompare(b.name, 'de-AT'));

const lineRisk = (lineRisks = []) => new Map((lineRisks || [])
  .map((item) => [String(item.line), Number.isFinite(Number(item.risk)) ? Number(item.risk) : 35]));

const findStation = (name) => stationMap.get(normalise(name));

const transferStations = (fromLine, toLine) => JOURNEY_STATIONS
  .filter((station) => station.lines.includes(fromLine) && station.lines.includes(toLine))
  .map((station) => station.name);

/**
 * Ranks direct and one-transfer options by operational risk. It intentionally
 * does not invent journey minutes: exact routing remains the operator's job,
 * while this layer answers which available path is more resilient right now.
 */
export const buildRiskAwareJourneys = ({ origin, destination, lineRisks = [] } = {}) => {
  const from = findStation(origin);
  const to = findStation(destination);
  if (!from || !to || normalise(from.name) === normalise(to.name)) return [];

  const risks = lineRisk(lineRisks);
  const options = [];
  const directLines = from.lines.filter((line) => U_LINES.has(line) && to.lines.includes(line));
  directLines.forEach((line) => {
    const risk = risks.get(line) ?? 35;
    options.push({
      id: `direct-${line}`,
      lines: [line],
      transfer: null,
      risk: Math.round(risk),
      resilience: clamp(Math.round(100 - risk), 5, 98),
      label: `Direct ${line}`,
      evidence: risk < 30 ? 'lowest current line risk' : 'direct route with current line risk',
    });
  });

  const fromLines = from.lines.filter((line) => U_LINES.has(line));
  const toLines = to.lines.filter((line) => U_LINES.has(line));
  for (const first of fromLines) {
    for (const second of toLines) {
      if (first === second) continue;
      const station = transferStations(first, second)[0];
      if (!station) continue;
      const risk = Math.round(((risks.get(first) ?? 35) + (risks.get(second) ?? 35)) / 2 + 12);
      options.push({
        id: `transfer-${first}-${second}-${station}`,
        lines: [first, second],
        transfer: station,
        risk: clamp(risk, 0, 98),
        resilience: clamp(Math.round(100 - risk), 5, 98),
        label: `${first} → ${second}`,
        evidence: `one transfer at ${station}`,
      });
    }
  }

  return options
    .sort((a, b) => a.risk - b.risk || a.lines.length - b.lines.length)
    .filter((option, index, all) => all.findIndex((candidate) => candidate.label === option.label) === index)
    .slice(0, 4);
};

/** Find a lower-risk fallback when a current train's connection is fragile. */
export const buildRescueOptions = ({ vehicles = [], lineRisks = [], now = Date.now() } = {}) => {
  const risks = lineRisk(lineRisks);
  return vehicles
    .filter((vehicle) => vehicle?.isLive && vehicle.targetStation)
    .flatMap((vehicle) => estimateConnections(vehicle, now).map((connection) => {
      const probability = Number(connection.probability) || 0;
      return {
        id: `${vehicle.id}-${connection.station}-${connection.line}`,
        fromLine: vehicle.line,
        fromDestination: vehicle.direction,
        station: connection.station,
        line: connection.line,
        destination: connection.destination,
        probability,
        departureSeconds: connection.departureSeconds,
        rating: connection.rating,
        fallbackRisk: risks.get(connection.line) ?? 35,
        action: probability < 50 ? 'Plan this fallback now' : 'Keep this as a backup',
      };
    }))
    .filter((item) => item.probability < 85)
    .sort((a, b) => a.probability - b.probability || a.fallbackRisk - b.fallbackRisk)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.station === item.station && candidate.line === item.line && candidate.destination === item.destination) === index)
    .slice(0, 6);
};

/**
 * A station-level pressure estimate from the departures we already cache.
 * This is a nowcast, not an occupancy sensor: it combines near departures,
 * bunching/gap evidence and peak-hour context.
 */
export const buildStationCrowdingNowcast = ({ entries = [], issues = [], now = Date.now(), context = {} } = {}) => {
  const hour = new Date(now).getHours() + new Date(now).getMinutes() / 60;
  const peak = [1, 2, 3, 4, 5].includes(new Date(now).getDay())
    && ((hour >= 7 && hour <= 9.5) || (hour >= 16 && hour <= 19));
  const holiday = context.holidays || {};
  const weather = context.weatherNowcast || {};
  const eventSignal = context.viennaEvents || context['vienna-events'] || {};
  const trafficSignal = context.evisTraffic || context['evis-traffic'] || {};
  const eventPressure = Number(eventSignal.pressureScore || eventSignal.crowdingScore || trafficSignal.stationPressureScore || 0);
  const holidayAdjustment = holiday.isPublicHoliday || holiday.isSchoolHoliday ? -8 : 0;
  const weatherAdjustment = Number(weather.next60MinPrecipitation) >= 2 ? 6 : Number(weather.precipitation) >= 1 ? 3 : 0;
  const byStation = new Map();
  for (const entry of entries) {
    const station = clean(entry?.stationName);
    if (!station) continue;
    const arrivals = (entry.arrivals || []).filter((arrival) => arrival?.isLive && Number.isFinite(Number(arrival.seconds)));
    if (!arrivals.length) continue;
    const current = byStation.get(station) || { station, lines: new Set(), nextFive: 0, nextTen: 0, delays: 0 };
    arrivals.forEach((arrival) => {
      current.lines.add(String(arrival.line));
      if (arrival.seconds <= 5 * 60) current.nextFive += 1;
      if (arrival.seconds <= 10 * 60) current.nextTen += 1;
      if (Number(arrival.reportedDelaySeconds) >= 180) current.delays += 1;
    });
    byStation.set(station, current);
  }

  return [...byStation.values()].map((item) => {
    const stationIssues = issues.filter((issue) => normalise(issue.station) === normalise(item.station));
    const bunches = stationIssues.filter((issue) => issue.type === 'bunch').length;
    const gaps = stationIssues.filter((issue) => issue.type === 'gap').length;
    const score = clamp(Math.round(
      20 + item.nextFive * 9 + item.nextTen * 3 + item.delays * 5
      + bunches * 13 + gaps * 8 + (peak ? 14 : 0) + holidayAdjustment + weatherAdjustment + eventPressure,
    ), 5, 99);
    const level = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low';
    const evidence = [
      item.nextFive ? `${item.nextFive} live departures in 5 min` : null,
      bunches ? `${bunches} bunching signal${bunches > 1 ? 's' : ''}` : null,
      gaps ? `${gaps} service gap${gaps > 1 ? 's' : ''}` : null,
      peak ? 'weekday peak' : null,
      holiday.isPublicHoliday ? 'public holiday baseline' : null,
      holiday.isSchoolHoliday ? 'school holiday baseline' : null,
      weatherAdjustment ? 'rain nowcast' : null,
      eventPressure ? 'event/traffic pressure signal' : null,
    ].filter(Boolean).join(' · ') || 'normal service pattern';
    return { station: item.station, lines: [...item.lines].sort(), score, level, evidence };
  }).sort((a, b) => b.score - a.score).slice(0, 8);
};

const words = (value) => new Set(normalise(value).split(/[^a-z0-9äöüß]+/).filter((word) => word.length > 2));

/** Match current notices to previously observed local incident records. */
export const buildIncidentSimilarities = ({ alerts = [], history = [] } = {}) => alerts.map((alert) => {
  const currentLines = new Set((alert.lines || []).map(String));
  const currentWords = words(`${alert.title} ${alert.description} ${alert.reason}`);
  const candidates = history.filter((item) => item && item.id !== alert.id).map((item) => {
    const lines = new Set((item.lines || []).map(String));
    const lineOverlap = [...currentLines].filter((line) => lines.has(line)).length;
    const itemWords = words(`${item.title} ${item.description} ${item.reason}`);
    const wordOverlap = [...currentWords].filter((word) => itemWords.has(word)).length;
    const stationMatch = alert.station && item.station && normalise(alert.station) === normalise(item.station) ? 2 : 0;
    return { item, score: lineOverlap * 3 + wordOverlap + stationMatch };
  }).filter((candidate) => candidate.score >= 3).sort((a, b) => b.score - a.score);

  const unique = candidates.filter((candidate, index, all) => all.findIndex((other) => other.item.id === candidate.item.id) === index).slice(0, 3);
  return {
    alertId: alert.id,
    title: alert.title,
    matches: unique.length,
    examples: unique.map(({ item }) => ({ title: item.title, station: item.station, observedAt: item.observedAt })),
    status: unique.length ? 'historical matches found' : history.length ? 'no close local match yet' : 'collecting incident history',
  };
});

const FEEDBACK_KEY = 'vienna_prediction_feedback_v1';

const readFeedback = () => {
  try {
    const value = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

export const recordPredictionFeedback = ({ model, outcome, context = '' } = {}) => {
  const row = { model: clean(model) || 'unknown', outcome: clean(outcome), context: clean(context).slice(0, 160), createdAt: Date.now() };
  try {
    const next = [...readFeedback(), row].slice(-500);
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(next));
  } catch {
    // Private browsing or a full store must not block the map.
  }
  return row;
};

export const getPredictionFeedbackSummary = () => readFeedback().reduce((summary, item) => {
  const model = item.model || 'unknown';
  if (!summary[model]) summary[model] = { useful: 0, inaccurate: 0 };
  if (item.outcome === 'useful') summary[model].useful += 1;
  if (item.outcome === 'inaccurate') summary[model].inaccurate += 1;
  return summary;
}, {});

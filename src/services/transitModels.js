import arrivalStore from './arrivalStore';
import trainPositionEngine from './trainPositionEngine';
import { getDistance } from '../utils/geoUtils';

const LINES = ['U1', 'U2', 'U3', 'U4', 'U6'];
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const probability = (margin, uncertainty) => clamp(
  Math.round((1 / (1 + Math.exp(-1.702 * margin / uncertainty))) * 100), 2, 98
);

const INTERCHANGES = [
  ['U1', 'U2', 'U4'], // Karlsplatz
  ['U1', 'U3'],       // Stephansplatz
  ['U1', 'U4'],       // Schwedenplatz
  ['U2', 'U3'],       // Volkstheater
  ['U2', 'U4'],       // Schottenring
  ['U3', 'U4'],       // Landstraße
  ['U3', 'U6'],       // Westbahnhof
  ['U4', 'U6'],       // Längenfeldgasse / Spittelau
];

const connectedLines = (line) => new Set(
  INTERCHANGES.filter((group) => group.includes(line)).flatMap((group) => group)
);

/** Experimental risk that today's irregularity continues through the network. */
export const forecastDelayPropagation = (issues = [], alerts = []) => {
  const seeds = new Map();
  for (const issue of issues) {
    const risk = issue.type === 'gap'
      ? clamp(55 + issue.severity / 8, 55, 88)
      : clamp(42 + issue.severity / 5, 42, 68);
    seeds.set(issue.line, Math.max(seeds.get(issue.line) || 0, risk));
  }
  for (const alert of alerts) {
    for (const line of alert.lines || []) seeds.set(line, Math.max(seeds.get(line) || 0, 85));
  }

  return [10, 20, 30].map((minutes) => {
    const risks = new Map();
    for (const [line, seed] of seeds) {
      const persistence = seed * (minutes === 10 ? 1 : minutes === 20 ? 0.88 : 0.76);
      risks.set(line, Math.max(risks.get(line) || 0, persistence));
      if (minutes >= 20) {
        for (const connected of connectedLines(line)) {
          if (connected === line) continue;
          const spillover = seed * (minutes === 20 ? 0.4 : 0.5);
          risks.set(connected, Math.max(risks.get(connected) || 0, spillover));
        }
      }
    }
    return {
      minutes,
      lines: [...risks.entries()]
        .map(([line, risk]) => ({ line, risk: Math.round(risk) }))
        .filter((item) => item.risk >= 25)
        .sort((a, b) => b.risk - a.risk),
    };
  });
};

/** A transparent pressure proxy. It is deliberately never called occupancy. */
export const estimateCrowdingRisk = (issues = [], now = new Date()) => {
  const hour = now.getHours();
  const weekday = now.getDay() > 0 && now.getDay() < 6;
  const peak = weekday && ((hour >= 7 && hour < 10) || (hour >= 16 && hour < 19));
  return LINES.map((line) => {
    let score = 24 + (peak ? 24 : 0) + (line === 'U1' || line === 'U3' ? 7 : 0);
    const signals = issues.filter((issue) => issue.line === line);
    if (signals.some((issue) => issue.type === 'gap')) score += 28;
    if (signals.some((issue) => issue.type === 'bunch')) score += 14;
    score = clamp(Math.round(score), 10, 92);
    return {
      line,
      score,
      level: score >= 68 ? 'high' : score >= 42 ? 'medium' : 'low',
      reason: signals.some((issue) => issue.type === 'gap')
        ? 'large service interval'
        : peak ? 'weekday peak period' : 'time-of-day baseline',
    };
  });
};

/** Elevator-outage impact and adjacent access points to check. */
export const analyseAccessibility = (alerts = []) => {
  const byStation = new Map();
  for (const alert of alerts.filter((item) => item.isElevator && item.station)) {
    const lines = alert.lines?.length ? alert.lines : LINES.filter(
      (line) => Boolean(trainPositionEngine.findStation(line, alert.station))
    );
    if (lines.length === 0) continue;
    const alternatives = [];
    for (const line of lines) {
      const stations = trainPositionEngine.getLineStations(line);
      const affected = trainPositionEngine.findStation(line, alert.station);
      const index = stations.findIndex((station) => station.id === affected?.id);
      if (index > 0) alternatives.push(stations[index - 1].name);
      if (index >= 0 && index < stations.length - 1) alternatives.push(stations[index + 1].name);
    }
    const impact = {
      id: alert.id,
      station: alert.station,
      lines,
      severity: lines.length > 1 ? 'high' : 'medium',
      impact: lines.length > 1
        ? 'Step-free interchange may be interrupted.'
        : 'Step-free station access may be interrupted.',
      alternatives: [...new Set(alternatives)].slice(0, 4),
      status: alert.status || 'reported unavailable',
    };
    const existing = byStation.get(alert.station);
    if (!existing || impact.lines.length > existing.lines.length) byStation.set(alert.station, impact);
  }
  return [...byStation.values()];
};

/** Catch probability from the user's current fix to a selected station. */
export const estimateLeaveNow = (stationProps, userLocation, now = Date.now()) => {
  if (!stationProps || userLocation?.status !== 'located') return null;
  const station = LINES.map((line) => trainPositionEngine.findStation(line, stationProps.name))
    .find(Boolean);
  if (!station) return null;
  const distanceMetres = getDistance(userLocation.coordinates, station.coords);
  const walkingSeconds = Math.round(distanceMetres / 1.25 + 45);
  const uncertainty = Math.max(45, 30 + (userLocation.accuracy || 30) / 1.25);
  const cached = arrivalStore.getCachedArrivals(stationProps, now);
  if (!cached?.arrivals?.length) return { distanceMetres, walkingSeconds, options: [] };
  const options = cached.arrivals.slice(0, 4).map((arrival) => {
    const marginSeconds = arrival.seconds - walkingSeconds;
    const chance = probability(marginSeconds, uncertainty);
    return {
      line: arrival.line,
      destination: arrival.destination,
      departureSeconds: arrival.seconds,
      chance,
      marginSeconds,
      advice: chance >= 80 ? 'leave now' : chance >= 45 ? 'tight' : 'take the following train',
    };
  });
  return { distanceMetres, walkingSeconds, options };
};

/** Grounded explanation assembled only from evidence visible elsewhere. */
export const explainLine = ({ line, issues = [], alerts = [], reliability = [], crowding = [] }) => {
  const lineIssues = issues.filter((issue) => issue.line === line);
  const lineAlerts = alerts.filter((alert) => alert.lines?.includes(line));
  const history = reliability.find((item) => item.line === line);
  const pressure = crowding.find((item) => item.line === line);
  const evidence = [];
  if (lineIssues.some((issue) => issue.type === 'gap')) {
    const gap = lineIssues.find((issue) => issue.type === 'gap');
    evidence.push(`${gap.label} is visible towards ${gap.direction} at ${gap.station}.`);
  }
  if (lineIssues.some((issue) => issue.type === 'bunch')) {
    evidence.push('Two predicted trains are unusually close together.');
  }
  if (lineAlerts.length) evidence.push(`${lineAlerts.length} official service notice${lineAlerts.length === 1 ? ' is' : 's are'} active.`);
  if (history?.observations >= 3) evidence.push(`Local reliability is ${history.score}% across ${history.observations} observations.`);
  if (pressure) evidence.push(`Passenger-pressure proxy is ${pressure.level}, driven by ${pressure.reason}.`);
  return {
    line,
    status: lineIssues.length || lineAlerts.length ? 'Irregularity evidence found' : 'No strong irregularity evidence',
    summary: evidence.length
      ? evidence.join(' ')
      : 'Live predictions currently show no large gaps, bunching, or official line notice.',
    evidenceCount: lineIssues.length + lineAlerts.length,
  };
};

export { LINES };

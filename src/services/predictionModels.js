// Experimental prediction layer. These models deliberately consume the same
// public departures, inferred positions and official notices already used by
// the map. They are decision-support estimates, not dispatcher telemetry.
const LINES = ['U1', 'U2', 'U3', 'U4', 'U6'];
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 0) => Number(Number(value).toFixed(digits));
const lineOf = (value) => String(value || '').toUpperCase();

export const predictDwellTimes = ({ vehicles = [] } = {}) => vehicles
  .filter((vehicle) => vehicle?.isLive && vehicle.status === 'At Platform' && vehicle.targetStation)
  .map((vehicle) => {
    const observed = Number(vehicle.secondsUnheard);
    const minutes = Number.isFinite(observed) ? round(observed / 60, 1) : 0.8;
    const risk = clamp(Math.round(25 + minutes * 15 + (vehicle.positionUncertaintyMetres || 0) / 80), 5, 99);
    return {
      line: lineOf(vehicle.line), station: vehicle.targetStation,
      predictedMinutes: round(Math.max(0.5, minutes + 0.6), 1),
      risk, confidence: clamp(Math.round(90 - (vehicle.positionUncertaintyMetres || 0) / 30), 35, 90),
      evidence: minutes >= 2 ? 'prolonged platform observation' : 'normal dwell baseline',
    };
  })
  .sort((a, b) => b.risk - a.risk).slice(0, 8);

export const predictHeadwayRisk = ({ issues = [], arrivals = [] } = {}) => {
  const output = [];
  for (const line of LINES) {
    const lineIssues = issues.filter((item) => lineOf(item.line) === line);
    const live = arrivals.filter((arrival) => arrival.isLive && lineOf(arrival.line) === line
      && Number.isFinite(arrival.seconds)).sort((a, b) => a.seconds - b.seconds);
    const gaps = live.slice(1).map((arrival, index) => arrival.seconds - live[index].seconds);
    const largestGap = Math.max(0, ...gaps);
    const smallestGap = gaps.length ? Math.min(...gaps) : null;
    const gap = lineIssues.find((item) => item.type === 'gap');
    const bunch = lineIssues.find((item) => item.type === 'bunch');
    const risk = clamp(Math.round(
      (gap ? 70 + Number(gap.severity || 0) / 20 : largestGap >= 12 * 60 ? 65 : 15)
      + (bunch || (smallestGap !== null && smallestGap < 120) ? 20 : 0),
    ), 0, 99);
    output.push({
      line, risk, status: risk >= 70 ? 'high' : risk >= 40 ? 'watch' : 'stable',
      largestGapMinutes: largestGap ? round(largestGap / 60, 1) : null,
      smallestGapMinutes: smallestGap === null ? null : round(smallestGap / 60, 1),
      horizon: risk >= 40 ? 'next 20 min' : 'next 30 min',
      evidence: gap ? gap.label : bunch ? bunch.label : largestGap >= 12 * 60 ? 'large live interval' : 'regular departures',
    });
  }
  return output.sort((a, b) => b.risk - a.risk);
};

export const predictDisruptionResolution = ({ disruptions = [], issues = [], reliability = [] } = {}) => {
  if (!disruptions.length) return [{ status: 'clear', window: 'No active official incident', confidence: 30, evidence: 'traffic information feed' }];
  return disruptions.slice(0, 8).map((incident) => {
    const lines = incident.lines || [];
    const issueCount = issues.filter((item) => lines.includes(item.line)).length;
    const reliabilityEvidence = lines.map((line) => reliability.find((item) => item.line === line)?.observations || 0)
      .reduce((sum, item) => sum + item, 0);
    const severity = /ausfall|unterbrech|störung|disruption|closed/i.test(`${incident.title} ${incident.description}`) ? 20 : 8;
    const minutes = clamp(Math.round(10 + severity + issueCount * 5 + (lines.length > 1 ? 8 : 0)), 8, 75);
    return {
      title: incident.title || 'Service notice', line: lines[0] || 'Network',
      status: incident.endsAt ? 'scheduled end known' : 'estimated',
      window: `${minutes}–${minutes + 15} min`,
      confidence: clamp(35 + Math.min(30, reliabilityEvidence), 25, 75),
      evidence: incident.endsAt ? 'official end time published' : 'notice severity + active service pattern',
    };
  });
};

export const classifyDelaySeverity = ({ arrivals = [], disruptions = [] } = {}) => LINES.map((line) => {
  const values = arrivals.filter((arrival) => arrival.isLive && lineOf(arrival.line) === line)
    .map((arrival) => Number(arrival.reportedDelaySeconds)).filter(Number.isFinite);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const incident = disruptions.some((item) => item.lines?.includes(line));
  const score = clamp(Math.round(Math.max(mean / 60 * 8, incident ? 65 : 0)), 0, 99);
  const category = score >= 75 ? 'severe' : score >= 50 ? 'major' : score >= 25 ? 'minor' : 'on time';
  return { line, category, score, meanMinutes: round(mean / 60, 1), samples: values.length, evidence: incident ? 'official notice' : `${values.length} reported arrivals` };
});

export const predictTransferSuccess = ({ transfers = [] } = {}) => transfers.slice(0, 8).map((item) => ({
  ...item,
  probability: clamp(Math.round(Number(item.probability) || 0), 1, 99),
  model: 'margin + uncertainty',
}));

export const scoreRouteReliability = ({ routeRisk = [], reliability = [] } = {}) => routeRisk.map((route) => {
  const historical = reliability.find((item) => item.line === route.line);
  const historicalScore = Number.isFinite(historical?.score) ? historical.score : 65;
  const score = clamp(Math.round(historicalScore * 0.6 + (100 - route.risk) * 0.4), 0, 100);
  return { line: route.line, score, risk: 100 - score, alternative: route.alternative, evidence: historical?.observations ? `${historical.observations} local observations + live risk` : 'live risk only' };
}).sort((a, b) => a.score - b.score);

export const predictCancellationRisk = ({ arrivals = [], disruptions = [], issues = [] } = {}) => LINES.map((line) => {
  const count = arrivals.filter((arrival) => arrival.isLive && lineOf(arrival.line) === line).length;
  const incident = disruptions.some((item) => item.lines?.includes(line));
  const gap = issues.some((item) => item.line === line && item.type === 'gap');
  const risk = clamp((incident ? 55 : 0) + (gap ? 25 : 0) + (count < 2 ? 12 : 0), 0, 95);
  return { line, risk, status: risk >= 65 ? 'high' : risk >= 30 ? 'watch' : 'low', action: risk >= 65 ? 'check next departure' : 'routine monitoring' };
}).sort((a, b) => b.risk - a.risk);

export const forecastCrowding = ({ crowding = [], now = Date.now(), issues = [] } = {}) => {
  const hour = new Date(now).getHours();
  const peak = new Date(now).getDay() > 0 && new Date(now).getDay() < 6 && ((hour >= 7 && hour < 10) || (hour >= 16 && hour < 19));
  return crowding.map((item) => {
    const issueBoost = issues.some((issue) => issue.line === item.line && issue.type === 'gap') ? 12 : 0;
    const score = clamp(item.score + (peak ? 8 : 0) + issueBoost, 0, 99);
    return { line: item.line, score, window: 'next 30–60 min', level: score >= 75 ? 'high' : score >= 45 ? 'medium' : 'low', source: 'service-gap + calendar proxy' };
  });
};

export const predictWeatherImpact = ({ weather = null, now = Date.now() } = {}) => {
  if (!weather) return { status: 'not connected', impact: 'No weather feed connected', confidence: 0, horizon: '—' };
  const precipitation = Number(weather.precipitation ?? weather.rain ?? 0);
  const wind = Number(weather.windSpeed ?? weather.wind ?? 0);
  const impact = clamp(Math.round(precipitation * 8 + Math.max(0, wind - 35) * 1.2), 0, 95);
  return { status: impact >= 60 ? 'elevated' : impact >= 25 ? 'watch' : 'routine', impact, confidence: 55, horizon: new Date(now + 60 * 60 * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
};

export const predictEventDemand = ({ events = [], now = Date.now() } = {}) => {
  if (!events.length) {
    const hour = new Date(now).getHours();
    const peak = [7, 8, 9, 16, 17, 18].includes(hour);
    return { status: peak ? 'weekday peak baseline' : 'no event feed', score: peak ? 55 : 20, confidence: 20, evidence: 'calendar baseline only' };
  }
  const score = clamp(events.reduce((sum, event) => sum + Number(event.expectedDemand || event.demand || 50), 0) / events.length, 0, 99);
  return { status: score >= 70 ? 'high' : score >= 40 ? 'watch' : 'routine', score: round(score), confidence: 50, evidence: `${events.length} event signal${events.length === 1 ? '' : 's'}` };
};

export const predictSbahnConnections = ({ vehicles = [], now = Date.now() } = {}) => vehicles
  .filter((vehicle) => !vehicle.isLive && String(vehicle.line).startsWith('S') && vehicle.targetStation)
  .slice(0, 8)
  .map((vehicle) => ({
    line: vehicle.line, station: vehicle.targetStation, destination: vehicle.direction,
    minutes: round((vehicle.secondsToTarget || 0) / 60, 1), probability: 50,
    status: 'timetable-only', evidence: 'ÖBB schedule; no live S-Bahn delay feed', updatedAt: now,
  }));

export const detectPredictiveAnomalies = ({ vehicles = [], issues = [], arrivals = [] } = {}) => {
  const anomalies = issues.map((issue) => ({
    type: issue.type === 'gap' ? 'headway anomaly' : 'bunching anomaly', line: issue.line,
    detail: `${issue.label || issue.type} at ${issue.station || 'network'}`, severity: issue.type === 'gap' ? 'high' : 'medium',
  }));
  vehicles.filter((vehicle) => vehicle.isLive && Number(vehicle.positionConfidence) < 45).slice(0, 4).forEach((vehicle) => anomalies.push({
    type: 'position anomaly', line: vehicle.line, detail: `${vehicle.targetStation || 'unknown station'} has low position confidence`, severity: 'watch',
  }));
  const missingLines = LINES.filter((line) => !arrivals.some((arrival) => arrival.isLive && lineOf(arrival.line) === line));
  missingLines.forEach((line) => anomalies.push({ type: 'feed anomaly', line, detail: 'no live arrivals in current sweep', severity: 'watch' }));
  return anomalies.slice(0, 10);
};

export const calibrateUncertainty = ({ vehicles = [], reliability = [] } = {}) => LINES.map((line) => {
  const lineVehicles = vehicles.filter((vehicle) => vehicle.isLive && lineOf(vehicle.line) === line);
  const uncertainty = lineVehicles.length
    ? lineVehicles.reduce((sum, vehicle) => sum + (Number(vehicle.positionUncertaintyMetres) || 350), 0) / lineVehicles.length
    : 700;
  const history = reliability.find((item) => item.line === line);
  const intervalMinutes = clamp(round(uncertainty / 180, 1), 1, 8);
  const calibration = clamp(Math.round(100 - uncertainty / 12 + (history?.observations >= 10 ? 8 : 0)), 10, 95);
  return { line, intervalMinutes, calibration, sampleCount: lineVehicles.length, status: calibration >= 70 ? 'calibrated' : 'wide interval' };
});


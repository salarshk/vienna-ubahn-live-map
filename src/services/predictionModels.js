// Experimental prediction layer. These models deliberately consume the same
// public departures, inferred positions and official notices already used by
// the map. They are decision-support estimates, not dispatcher telemetry.
const LINES = ['U1', 'U2', 'U3', 'U4', 'U6'];
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 0) => Number(Number(value).toFixed(digits));
const lineOf = (value) => String(value || '').toUpperCase();
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const MODEL_STATUS = 'data-driven baseline · collecting labels';

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

/**
 * Model 3: per-station dwell forecast. This keeps the existing transparent
 * dwell estimate but gives it a stable model contract for later retraining
 * from observed platform-to-departure intervals.
 */
export const predictDwellForecast = ({ vehicles = [] } = {}) => predictDwellTimes({ vehicles })
  .map((item) => ({ ...item, model: 'dwell-time', trainingStatus: MODEL_STATUS }));

/**
 * Model 1: delay at several horizons. It combines the current official delay
 * distribution with the published line estimate and active incident context.
 * It is deliberately a baseline until enough labelled journeys exist for a
 * separately validated multi-horizon learner.
 */
export const predictMultiHorizonDelay = ({ arrivals = [], linePredictions = [], disruptions = [], now = Date.now() } = {}) => LINES.map((line) => {
  const observations = arrivals.filter((arrival) => arrival?.isLive && lineOf(arrival.line) === line)
    .map((arrival) => ({
      delay: finite(arrival.reportedDelaySeconds) === null ? null : finite(arrival.reportedDelaySeconds) / 60,
      lead: finite(arrival.secondsToReal ?? arrival.seconds),
    }))
    .filter((item) => item.delay !== null);
  const lineModel = finite(linePredictions.find((item) => lineOf(item.line) === line)?.minutes);
  const mean = observations.length
    ? observations.reduce((sum, item) => sum + item.delay, 0) / observations.length : 0;
  const sorted = observations.filter((item) => item.lead !== null).sort((a, b) => a.lead - b.lead);
  const trend = sorted.length >= 2
    ? clamp((sorted.at(-1).delay - sorted[0].delay) / Math.max(1, (sorted.at(-1).lead - sorted[0].lead) / 60), -0.5, 0.5)
    : 0;
  const incidentCount = disruptions.filter((item) => item?.lines?.map(lineOf).includes(line)).length;
  const incidentBoost = Math.min(4, incidentCount * 0.7);
  const centre = clamp(lineModel ?? mean, -2, 30);
  const forecasts = [2, 5, 10, 15].map((horizonMinutes) => {
    const predicted = clamp(centre + trend * horizonMinutes + incidentBoost * (horizonMinutes / 15), -2, 30);
    const spread = clamp(0.8 + (observations.length ? 1.5 / Math.sqrt(observations.length) : 2.5)
      + incidentCount * 0.5 + Math.abs(trend) * horizonMinutes, 0.8, 8);
    return {
      horizonMinutes,
      minutes: round(predicted, 1),
      lowMinutes: round(clamp(predicted - spread, -2, 30), 1),
      highMinutes: round(clamp(predicted + spread, -2, 30), 1),
    };
  });
  return {
    line, forecasts, samples: observations.length, incidentCount,
    confidence: clamp(Math.round(35 + Math.min(45, observations.length * 5) - incidentCount * 4), 15, 85),
    model: 'multi-horizon delay', trainingStatus: MODEL_STATUS,
    evidence: observations.length ? `${observations.length} official delay observations` : 'live delay observations not available',
    generatedAt: now,
  };
});

/**
 * Model 2: next-station ETA for every inferred live train. The range widens
 * with position uncertainty and old observations, rather than presenting an
 * inferred countdown as exact GPS truth.
 */
export const predictNextStationEta = ({ vehicles = [] } = {}) => vehicles
  .filter((vehicle) => vehicle?.isLive && vehicle.targetStation && finite(vehicle.secondsToTarget) !== null)
  .map((vehicle) => {
    const eta = Math.max(0, finite(vehicle.secondsToTarget) / 60);
    const uncertainty = Math.max(0.5, (finite(vehicle.positionUncertaintyMetres) || 250) / 180);
    const age = Math.max(0, finite(vehicle.lastDataAgeSeconds ?? vehicle.observationAgeSeconds) || 0) / 60;
    const spread = round(clamp(uncertainty + age, 0.5, 8), 1);
    return {
      id: vehicle.id, line: lineOf(vehicle.line), destination: vehicle.direction,
      station: vehicle.targetStation, etaMinutes: round(eta, 1),
      lowMinutes: round(Math.max(0, eta - spread), 1),
      highMinutes: round(eta + spread, 1),
      confidence: clamp(Math.round((finite(vehicle.positionConfidence) ?? 0.45) * 100 - spread * 4), 15, 95),
      model: 'next-station ETA', trainingStatus: MODEL_STATUS,
      evidence: vehicle.dataFreshness === 'within-3-seconds' ? 'fresh station observation + inferred position' : 'inferred position + station departure prediction',
    };
  })
  .sort((a, b) => a.etaMinutes - b.etaMinutes)
  .slice(0, 12);

export const predictHeadwayRisk = ({ issues = [], arrivals = [] } = {}) => {
  const output = [];
  for (const line of LINES) {
    const lineIssues = issues.filter((item) => lineOf(item.line) === line);
    const live = arrivals.filter((arrival) => arrival.isLive && lineOf(arrival.line) === line
      && Number.isFinite(arrival.seconds)).sort((a, b) => a.seconds - b.seconds);
    // Departures from different stations must not be compared with each
    // other. Grouping by station lets the model say where the interval issue
    // is expected instead of reporting only a line-level score.
    const byStation = new Map();
    for (const arrival of live) {
      const stationKey = String(arrival.stationName || arrival.stationId || 'network');
      if (!byStation.has(stationKey)) byStation.set(stationKey, []);
      byStation.get(stationKey).push(arrival);
    }
    let largestGap = 0;
    let largestGapStation = null;
    let smallestGap = null;
    let smallestGapStation = null;
    for (const [station, stationArrivals] of byStation) {
      stationArrivals.sort((a, b) => a.seconds - b.seconds);
      for (let index = 1; index < stationArrivals.length; index += 1) {
        const seconds = stationArrivals[index].seconds - stationArrivals[index - 1].seconds;
        if (seconds > largestGap) {
          largestGap = seconds;
          largestGapStation = station === 'network' ? null : station;
        }
        if (smallestGap === null || seconds < smallestGap) {
          smallestGap = seconds;
          smallestGapStation = station === 'network' ? null : station;
        }
      }
    }
    const gap = lineIssues.find((item) => item.type === 'gap');
    const bunch = lineIssues.find((item) => item.type === 'bunch');
    const gapStation = gap?.station || (largestGap >= 12 * 60 ? largestGapStation : null);
    const bunchStation = bunch?.station || (smallestGap !== null && smallestGap < 120 ? smallestGapStation : null);
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
      gapStation: gapStation || null,
      bunchStation: bunchStation || null,
      station: gapStation || bunchStation || null,
      location: gapStation && bunchStation && gapStation !== bunchStation
        ? `Gap near ${gapStation}; trains close near ${bunchStation}`
        : gapStation
          ? `Gap near ${gapStation}`
          : bunchStation
            ? `Trains close near ${bunchStation}`
            : 'Station location unavailable',
    });
  }
  return output.sort((a, b) => b.risk - a.risk);
};

/** Model 4: forecast the next headway anomaly and its station location. */
export const predictHeadwayForecast = ({ issues = [], arrivals = [] } = {}) => predictHeadwayRisk({ issues, arrivals })
  .map((item) => ({
    ...item,
    probability: item.risk,
    model: 'headway/bunching forecast',
    trainingStatus: MODEL_STATUS,
  }));

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

/** Model 5: recovery duration after a gap, bunching event or disruption. */
export const predictRecoveryForecast = ({ disruptions = [], issues = [], reliability = [] } = {}) => predictDisruptionResolution({ disruptions, issues, reliability })
  .map((item) => ({
    ...item,
    model: 'delay-recovery duration',
    trainingStatus: MODEL_STATUS,
  }));

/**
 * Model 6: incident impact. It joins official notice scope to current delay
 * observations and headway symptoms, producing an explainable impact estimate
 * rather than treating every notice as the same severity.
 */
export const predictDisruptionImpact = ({ disruptions = [], arrivals = [], issues = [], now = Date.now() } = {}) => {
  if (!disruptions.length) return [];
  return disruptions.slice(0, 10).map((incident, index) => {
    const lines = (incident.lines || []).map(lineOf).filter(Boolean);
    const delays = arrivals.filter((arrival) => arrival?.isLive && lines.includes(lineOf(arrival.line)))
      .map((arrival) => finite(arrival.reportedDelaySeconds)).filter((value) => value !== null).map((value) => value / 60);
    const lineIssues = issues.filter((issue) => lines.includes(lineOf(issue.line)));
    const meanDelay = delays.length ? delays.reduce((sum, value) => sum + value, 0) / delays.length : 0;
    const issueBoost = lineIssues.reduce((sum, issue) => sum + (issue.type === 'gap' ? 4 : 2), 0);
    const wordingBoost = /ausfall|unterbrech|störung|disruption|closed|kein betrieb/i.test(`${incident.title || ''} ${incident.description || incident.reason || ''}`) ? 8 : 3;
    const impactMinutes = round(clamp(Math.max(2, meanDelay + issueBoost + wordingBoost), 2, 60), 1);
    const affectedStations = [...new Set([
      incident.station,
      ...lineIssues.map((issue) => issue.station),
    ].filter(Boolean))].slice(0, 4);
    return {
      id: incident.id || `impact-${index}`,
      title: incident.title || 'Official service notice',
      lines, affectedStations, impactMinutes,
      level: impactMinutes >= 20 ? 'high' : impactMinutes >= 8 ? 'medium' : 'low',
      confidence: clamp(Math.round(35 + Math.min(35, delays.length * 5) + Math.min(20, lineIssues.length * 5)), 25, 90),
      samples: delays.length, model: 'disruption impact', trainingStatus: MODEL_STATUS,
      evidence: `${delays.length} delay observations + ${lineIssues.length} headway signal${lineIssues.length === 1 ? '' : 's'}`,
      generatedAt: now,
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

const quantile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};

/** Probabilistic delay bands rather than a single optimistic number. */
export const predictDelayBands = ({ arrivals = [], linePredictions = [] } = {}) => LINES.map((line) => {
  const observed = arrivals
    .filter((arrival) => arrival.isLive && lineOf(arrival.line) === line)
    .filter((arrival) => arrival.reportedDelaySeconds !== null && arrival.reportedDelaySeconds !== undefined)
    .map((arrival) => Number(arrival.reportedDelaySeconds) / 60)
    .filter(Number.isFinite);
  const model = Number(linePredictions.find((item) => item.line === line)?.minutes);
  const p50 = quantile(observed, 0.5);
  const p90 = quantile(observed, 0.9);
  const centre = Number.isFinite(model) ? model : (p50 ?? 0);
  const low = Math.max(-2, round(Math.min(p50 ?? centre, centre), 1));
  const high = Math.max(low, round(Math.max(p90 ?? centre + (observed.length ? 2 : 4), centre), 1));
  const confidence = clamp(Math.round(30 + Math.min(50, observed.length * 4) + (Number.isFinite(model) ? 15 : 0)), 20, 95);
  return {
    line, low, typical: round(centre, 1), high, confidence,
    samples: observed.length,
    horizon: 'next 15 min',
    evidence: observed.length ? `${observed.length} live delay observations` : 'model baseline only',
  };
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

const EVENT_TERMS = /concert|konzert|stadion|match|spiel|festival|messe|parade|marathon|event|feuerwerk|demo/i;

export const extractEventSignals = (alerts = []) => alerts
  .map((alert) => {
    const text = `${alert.title || ''} ${alert.description || alert.reason || ''}`;
    if (!EVENT_TERMS.test(text)) return null;
    const severity = /stadion|stadium|match|spiel|festival|marathon/i.test(text) ? 78 : 58;
    return {
      title: String(alert.title || 'Event-related service notice').slice(0, 120),
      lines: alert.lines || [], expectedDemand: severity,
      source: 'official service/news text',
    };
  })
  .filter(Boolean);

export const predictEventDemand = ({ events = [], alerts = [], now = Date.now() } = {}) => {
  const signals = events.length ? events : extractEventSignals(alerts);
  if (!signals.length) {
    const hour = new Date(now).getHours();
    const peak = [7, 8, 9, 16, 17, 18].includes(hour);
    return { status: peak ? 'weekday peak baseline' : 'no event feed', score: peak ? 55 : 20, confidence: 20, evidence: 'calendar baseline only' };
  }
  const score = clamp(signals.reduce((sum, event) => sum + Number(event.expectedDemand || event.demand || 50), 0) / signals.length, 0, 99);
  return { status: score >= 70 ? 'high' : score >= 40 ? 'watch' : 'routine', score: round(score), confidence: signals.some((event) => event.source) ? 45 : 50, evidence: `${signals.length} event signal${signals.length === 1 ? '' : 's'} from official notices`, signals };
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

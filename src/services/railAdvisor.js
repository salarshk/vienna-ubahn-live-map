const ADVISOR_API_URL = String(import.meta.env.VITE_ADVISOR_API_URL || '').trim();

const cleanText = (value, maximum = 180) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maximum);

const finiteNumber = (value, fallback = null) => Number.isFinite(Number(value))
  ? Number(value) : fallback;

const lineList = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map((line) => cleanText(line, 8))
  .filter(Boolean))].slice(0, 8);

const summariseArrivals = (arrivals = []) => {
  const byLine = new Map();
  arrivals.filter((arrival) => arrival?.isLive).forEach((arrival) => {
    const line = cleanText(arrival.line, 8);
    const real = finiteNumber(arrival.targetTimestamp);
    const planned = finiteNumber(arrival.plannedTargetTimestamp);
    if (!line || real === null || planned === null) return;
    const delay = Math.max(-2, Math.min(30, (real - planned) / 60000));
    const current = byLine.get(line) || { delays: [], destinations: new Set() };
    current.delays.push(delay);
    if (arrival.destination) current.destinations.add(cleanText(arrival.destination, 70));
    byLine.set(line, current);
  });

  return [...byLine.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([line, value]) => ({
    line,
    livePredictions: value.delays.length,
    averageReportedDelayMinutes: Number((value.delays.reduce((sum, item) => sum + item, 0) / value.delays.length).toFixed(1)),
    maximumReportedDelayMinutes: Number(Math.max(...value.delays).toFixed(1)),
    delayedPredictions: value.delays.filter((delay) => delay >= 3).length,
    sampleDestinations: [...value.destinations].slice(0, 3),
  }));
};

export const advisorIsConfigured = () => Boolean(ADVISOR_API_URL);

export const buildRailAdvisorEvidence = ({
  snapshot = {}, disruptions = [], forecasts = [], crowding = [], accessibility = [],
  delayMetrics = null, arrivals = [], delayPredictions = [], now = Date.now(),
} = {}) => ({
  generatedAt: new Date(now).toISOString(),
  scope: 'Vienna U-Bahn and S-Bahn public passenger information',
  sourceLimitations: [
    'U-Bahn positions are inferred from Wiener Linien departure predictions, not vehicle GPS.',
    'S-Bahn positions use the published timetable, not live vehicle GPS.',
    'Passenger-pressure values are transparent proxies, not measured occupancy.',
  ],
  headwayIssues: (snapshot.issues || []).slice(0, 8).map((issue) => ({
    type: cleanText(issue.type, 20),
    line: cleanText(issue.line, 8),
    direction: cleanText(issue.direction, 70),
    station: cleanText(issue.station, 70),
    intervalSeconds: finiteNumber(issue.seconds),
    label: cleanText(issue.label, 100),
  })),
  officialDisruptions: disruptions.slice(0, 10).map((incident) => ({
    title: cleanText(incident.title, 140),
    description: cleanText(incident.description || incident.reason, 240),
    lines: lineList(incident.lines),
    station: cleanText(incident.station, 80),
    priority: finiteNumber(incident.priority, 0),
    startsAt: cleanText(incident.startsAt, 40),
    endsAt: cleanText(incident.endsAt, 40),
  })),
  propagationForecast: forecasts.slice(0, 3).map((forecast) => ({
    horizonMinutes: finiteNumber(forecast.minutes, 0),
    lines: (forecast.lines || []).slice(0, 5).map((item) => ({
      line: cleanText(item.line, 8), riskPercent: finiteNumber(item.risk, 0),
    })),
  })),
  passengerPressureProxy: crowding.slice(0, 8).map((item) => ({
    line: cleanText(item.line, 8), level: cleanText(item.level, 16),
    score: finiteNumber(item.score, 0), reason: cleanText(item.reason, 140),
  })),
  accessibilityImpacts: accessibility.slice(0, 8).map((impact) => ({
    station: cleanText(impact.station, 80), lines: lineList(impact.lines),
    status: cleanText(impact.status, 80), impact: cleanText(impact.impact, 180),
    alternativesToCheck: (impact.alternatives || []).map((item) => cleanText(item, 80)).slice(0, 4),
  })),
  reliability: (snapshot.reliability || []).map((item) => ({
    line: cleanText(item.line, 8), scorePercent: finiteNumber(item.score),
    observations: finiteNumber(item.observations, 0),
  })),
  liveReportedDelayByLine: summariseArrivals(arrivals),
  modelDelayPredictions: delayPredictions.map((item) => ({
    line: cleanText(item.line, 8), predictedFinalDelayMinutes: finiteNumber(item.minutes, 0),
  })),
  delayModelEvaluation: delayMetrics ? {
    stage: cleanText(delayMetrics.validationStage || delayMetrics.status, 30),
    testJourneys: finiteNumber(delayMetrics.model?.sampleCount, 0),
    maeMinutes: finiteNumber(delayMetrics.model?.maeMinutes),
    rmseMinutes: finiteNumber(delayMetrics.model?.rmseMinutes),
    withinOneMinutePercent: finiteNumber(delayMetrics.model?.withinOneMinutePercent),
    deployed: Boolean(delayMetrics.deployment?.deployed),
    onlineCalibration: delayMetrics.onlineCalibration ? {
      status: cleanText(delayMetrics.onlineCalibration.status, 30),
      scoredJourneys: finiteNumber(delayMetrics.onlineCalibration.scoredJourneyCount, 0),
      maeMinutes: finiteNumber(delayMetrics.onlineCalibration.model?.maeMinutes),
      rmseMinutes: finiteNumber(delayMetrics.onlineCalibration.model?.rmseMinutes),
      deployed: Boolean(delayMetrics.onlineCalibration.deployment?.deployed),
    } : null,
  } : null,
});

export const requestRailAdvice = async ({ audience, goal, evidence }) => {
  if (!ADVISOR_API_URL) throw new Error('AI advisor backend is not connected yet.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(ADVISOR_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience, goal: cleanText(goal, 240), evidence }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'The AI advisor is temporarily unavailable.');
    if (!result.advice || !Array.isArray(result.advice.recommendations)) {
      throw new Error('The AI advisor returned an incomplete response.');
    }
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('The AI advisor took too long to respond.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};


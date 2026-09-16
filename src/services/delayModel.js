import { assessModelHealth } from './modelMonitoring';

const LINES = ['U1', 'U2', 'U3', 'U4', 'U6'];
const BASE_URL = import.meta.env.BASE_URL || '/';
const REPORT_BASE = `${BASE_URL}ml`.replace(/\/$/, '');

const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));
const DELAY_TERMS = /verspät|verkehrsbedingt|unregelmäßig|signalstörung|fahrzeugstörung|betriebsstörung|polizeieinsatz|kein betrieb|eingestellt|kurzführung/i;

export const incidentContextForLine = (disruptions, line, now = Date.now()) => {
  const active = (Array.isArray(disruptions) ? disruptions : []).filter((incident) => {
    if (!incident?.lines?.includes(line)) return false;
    const startsAt = Date.parse(incident.startsAt || '');
    const endsAt = Date.parse(incident.endsAt || '');
    return (!Number.isFinite(startsAt) || startsAt <= now) && (!Number.isFinite(endsAt) || endsAt >= now);
  });
  return {
    activeIncidentCount: active.length,
    incidentPriority: active.reduce((highest, incident) => Math.max(highest, Number(incident.priority) || 0), 0),
    delayRelatedIncident: active.some((incident) => DELAY_TERMS.test([
      incident.title, incident.description, incident.reason,
    ].filter(Boolean).join(' '))),
  };
};

export const featureVector = (arrival, now = Date.now()) => {
  const plannedTimestamp = Number(arrival?.plannedTargetTimestamp);
  const realTimestamp = Number(arrival?.targetTimestamp);
  if (!Number.isFinite(plannedTimestamp) || !Number.isFinite(realTimestamp)) return null;
  const planned = new Date(plannedTimestamp);
  const hour = planned.getUTCHours() + planned.getUTCMinutes() / 60;
  const weekday = planned.getUTCDay();
  const currentDelayMinutes = clamp((realTimestamp - plannedTimestamp) / 60000, -2, 30);
  const leadMinutes = clamp((realTimestamp - now) / 60000, 0, 30);
  return [
    1,
    currentDelayMinutes,
    leadMinutes,
    Math.sin(2 * Math.PI * hour / 24),
    Math.cos(2 * Math.PI * hour / 24),
    Math.sin(2 * Math.PI * weekday / 7),
    Math.cos(2 * Math.PI * weekday / 7),
    arrival.trafficJam ? 1 : 0,
    arrival.directionCode === 'H' ? 1 : 0,
    clamp(Number(arrival.activeIncidentCount) || 0, 0, 10),
    clamp(Number(arrival.incidentPriority) || 0, 0, 10),
    arrival.delayRelatedIncident ? 1 : 0,
    ...LINES.map((line) => arrival.line === line ? 1 : 0),
    currentDelayMinutes ** 2,
    leadMinutes ** 2,
    currentDelayMinutes * leadMinutes,
    Math.max(0, currentDelayMinutes),
    leadMinutes <= 5 ? 1 : 0,
    clamp(Number(arrival.delayTrendMinutes) || 0, -5, 5),
  ];
};

export const predictFinalDelay = (model, arrival, now = Date.now()) => {
  if (model?.status !== 'ready' || model.deployed === false || !Array.isArray(model.weights) || !Array.isArray(model.scaling)) {
    return null;
  }
  const vector = featureVector(arrival, now);
  if (!vector || vector.length !== model.weights.length) return null;
  if (model.algorithm === 'isotonic-delay-calibration'
    && Array.isArray(model.selectedModelParameters?.breakpoints)
    && Array.isArray(model.selectedModelParameters?.values)) {
    const breakpoints = model.selectedModelParameters.breakpoints;
    const values = model.selectedModelParameters.values;
    let index = breakpoints.findIndex((breakpoint) => vector[1] <= Number(breakpoint));
    if (index < 0) index = values.length - 1;
    const calibrated = Number(values[index]);
    if (!Number.isFinite(calibrated)) return null;
    const blend = Number(model.selectedModelParameters.blend) || 1;
    return clamp(vector[1] + blend * (calibrated - vector[1]), ...(model.predictionRangeMinutes || [-2, 30]));
  }
  if (model.algorithm === 'stacked-delay-ensemble'
    && Array.isArray(model.selectedModelParameters?.breakpoints)
    && Array.isArray(model.selectedModelParameters?.values)
    && Array.isArray(model.selectedModelParameters?.residualWeights)) {
    const parameters = model.selectedModelParameters;
    let index = parameters.breakpoints.findIndex((breakpoint) => vector[1] <= Number(breakpoint));
    if (index < 0) index = parameters.values.length - 1;
    const isotonic = Number(parameters.values[index]);
    if (!Number.isFinite(isotonic)) return null;
    const residualCorrection = vector.reduce((sum, feature, featureIndex) => {
      const scale = Number(model.scaling[featureIndex]?.scale) || 1;
      const mean = Number(model.scaling[featureIndex]?.mean) || 0;
      return sum + ((feature - mean) / scale) * Number(parameters.residualWeights[featureIndex] || 0);
    }, 0);
    const residual = vector[1] + (Number(parameters.residualBlend) || 1) * residualCorrection;
    const isotonicWeight = Number(parameters.isotonicWeight);
    const value = isotonicWeight * (vector[1] + (Number(parameters.blend) || 1) * (isotonic - vector[1]))
      + (1 - isotonicWeight) * residual;
    return clamp(value, ...(model.predictionRangeMinutes || [-2, 30]));
  }
  const correction = vector.reduce((sum, feature, index) => {
    const scale = Number(model.scaling[index]?.scale) || 1;
    const mean = Number(model.scaling[index]?.mean) || 0;
    return sum + ((feature - mean) / scale) * model.weights[index];
  }, 0);
  const value = model.algorithm === 'residual-ridge-ensemble'
    ? vector[1] + (Number(model.selectedModelParameters?.blend) || 1) * correction
    : correction;
  const [minimum, maximum] = model.predictionRangeMinutes || [-2, 30];
  return clamp(value, minimum, maximum);
};

const onlineMeanWithPrior = (stat, prior) => stat?.count ? Number(stat.sum) / (Number(stat.count) + prior) : 0;

export const predictOnlineDelay = (model, arrival) => {
  const online = model?.onlineCalibration;
  if (online?.status !== 'ready' || online.deployed === false || !online.state) return null;
  const currentDelay = (Number(arrival?.targetTimestamp) - Number(arrival?.plannedTargetTimestamp)) / 60000;
  if (!Number.isFinite(currentDelay)) return null;
  const context = arrival.delayRelatedIncident || Number(arrival.activeIncidentCount) > 0
    ? 'incident' : arrival.trafficJam ? 'traffic' : 'normal';
  const correction = onlineMeanWithPrior(online.state.global, 24)
    + onlineMeanWithPrior(online.state.lines?.[arrival.line], 12)
    + onlineMeanWithPrior(online.state.contexts?.[context], 10);
  const [minimum, maximum] = online.predictionRangeMinutes || [-2, 30];
  return clamp(currentDelay + correction, minimum, maximum);
};

class DelayModelStore {
  constructor() {
    this.snapshot = { status: 'loading', model: null, metrics: null, error: null };
    this.listeners = new Set();
    this.inFlight = null;
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  async load() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = Promise.all([
      fetch(`${REPORT_BASE}/delay-model.json`, { cache: 'no-store' }),
      fetch(`${REPORT_BASE}/delay-metrics.json`, { cache: 'no-store' }),
    ]).then(async ([modelResponse, metricsResponse]) => {
      if (!modelResponse.ok || !metricsResponse.ok) throw new Error('Model report is unavailable');
      const [model, metrics] = await Promise.all([modelResponse.json(), metricsResponse.json()]);
      const health = assessModelHealth({ model, metrics });
      // A published candidate remains visible for transparency, but predictions
      // are disabled automatically when the monitor detects a stale, invalid or
      // baseline-worse model. This is a safe client-side rollback to no ML.
      const activeModel = health.rollback ? { ...model, deployed: false } : model;
      this.snapshot = {
        status: model.status, model: activeModel, metrics, health,
        error: null,
      };
      this.notify();
      return this.snapshot;
    }).catch(() => {
      this.snapshot = { status: 'error', model: null, metrics: null, error: 'Model report is unavailable.' };
      this.notify();
      return this.snapshot;
    }).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
}

export const delayModelStore = new DelayModelStore();
export default delayModelStore;

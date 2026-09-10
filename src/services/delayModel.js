const LINES = ['U1', 'U2', 'U3', 'U4', 'U6'];
const BASE_URL = import.meta.env.BASE_URL || '/';
const REPORT_BASE = `${BASE_URL}ml`.replace(/\/$/, '');

const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));

export const featureVector = (arrival, now = Date.now()) => {
  const plannedTimestamp = Number(arrival?.plannedTargetTimestamp);
  const realTimestamp = Number(arrival?.targetTimestamp);
  if (!Number.isFinite(plannedTimestamp) || !Number.isFinite(realTimestamp)) return null;
  const planned = new Date(plannedTimestamp);
  const hour = planned.getUTCHours() + planned.getUTCMinutes() / 60;
  const weekday = planned.getUTCDay();
  return [
    1,
    clamp((realTimestamp - plannedTimestamp) / 60000, -2, 30),
    clamp((realTimestamp - now) / 60000, 0, 30),
    Math.sin(2 * Math.PI * hour / 24),
    Math.cos(2 * Math.PI * hour / 24),
    Math.sin(2 * Math.PI * weekday / 7),
    Math.cos(2 * Math.PI * weekday / 7),
    arrival.trafficJam ? 1 : 0,
    arrival.directionCode === 'H' ? 1 : 0,
    ...LINES.map((line) => arrival.line === line ? 1 : 0),
  ];
};

export const predictFinalDelay = (model, arrival, now = Date.now()) => {
  if (model?.status !== 'ready' || model.deployed === false || !Array.isArray(model.weights) || !Array.isArray(model.scaling)) {
    return null;
  }
  const vector = featureVector(arrival, now);
  if (!vector || vector.length !== model.weights.length) return null;
  const value = vector.reduce((sum, feature, index) => {
    const scale = Number(model.scaling[index]?.scale) || 1;
    const mean = Number(model.scaling[index]?.mean) || 0;
    return sum + ((feature - mean) / scale) * model.weights[index];
  }, 0);
  const [minimum, maximum] = model.predictionRangeMinutes || [-2, 30];
  return clamp(value, minimum, maximum);
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
      this.snapshot = { status: model.status, model, metrics, error: null };
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

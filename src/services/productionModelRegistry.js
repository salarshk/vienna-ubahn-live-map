// Models that are safe to expose as monitored production features. These are
// guarded operational estimates: they may use a transparent live baseline,
// but every output carries its evidence and remains monitored for freshness
// and performance.

export const MONITORED_PRODUCTION_MODEL_IDS = Object.freeze([
  'multi-horizon-delay',
  'delay-bands',
  'route-reliability',
  'headway-bunching',
  'predictive-anomaly',
  'weather-impact',
]);

export const MONITORED_PRODUCTION_MODELS = Object.freeze({
  'multi-horizon-delay': {
    name: 'Multi-horizon delay',
    output: '2, 5, 10 and 15 minute delay outlooks',
    mode: 'guarded baseline',
    guardrail: 'Falls back to the current operator estimate when live delay evidence is missing.',
  },
  'delay-bands': {
    name: 'Probabilistic delay bands',
    output: 'Typical and high-delay ranges',
    mode: 'calibrated range',
    guardrail: 'Shows the evidence count and widens the range when observations are sparse.',
  },
  'route-reliability': {
    name: 'Route reliability',
    output: 'Line reliability and lower-risk alternatives',
    mode: 'risk-adjusted score',
    guardrail: 'Uses live risk plus observed history; it never claims a guaranteed journey time.',
  },
  'headway-bunching': {
    name: 'Headway and bunching',
    output: 'Predicted gaps, close trains and their station area',
    mode: 'early-warning signal',
    guardrail: 'Reports an operational signal, not a confirmed cancellation or control-room instruction.',
  },
  'predictive-anomaly': {
    name: 'Predictive anomaly detection',
    output: 'Unusual feed, position and headway patterns',
    mode: 'monitored anomaly flag',
    guardrail: 'An anomaly requires verification; it is not proof of a vehicle or infrastructure fault.',
  },
  'weather-impact': {
    name: 'Weather impact',
    output: 'Short-horizon weather-related delay pressure',
    mode: 'observational context',
    guardrail: 'Reports correlation with weather, not causal attribution or an official warning.',
  },
});

export const isMonitoredProductionModel = (id) => MONITORED_PRODUCTION_MODEL_IDS.includes(id);

export const monitoredProductionMeta = (id, extra = {}) => {
  const definition = MONITORED_PRODUCTION_MODELS[id];
  if (!definition) return extra;
  return {
    id,
    stage: 'monitored-production',
    ...definition,
    ...extra,
  };
};


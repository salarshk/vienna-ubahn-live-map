#!/usr/bin/env node

/*
 * Build the training/readiness report for the 17 experimental models shown in
 * Prediction Lab.  This report is intentionally separate from the U-Bahn
 * delay model: it never promotes a heuristic to "trained" just because a
 * card has an output.  A model is marked candidate only when the archived
 * data contains a usable target; otherwise the report names the missing
 * label or feed.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const OBSERVATION_DIR = resolve(ROOT, process.env.DELAY_OBSERVATIONS_DIR || 'data/ml/observations');
const HEADWAY_DIR = resolve(ROOT, process.env.HEADWAY_EVENTS_DIR || 'data/ml/headway-events');
const INCIDENTS_PATH = resolve(ROOT, process.env.DELAY_INCIDENTS_PATH || 'data/ml/ubahn-incidents.json');
const DELAY_METRICS_PATH = resolve(ROOT, process.env.DELAY_METRICS_PATH || 'public/ml/delay-metrics.json');
const OUTPUT_PATH = resolve(ROOT, process.env.OPERATIONAL_MODELS_PATH || 'public/ml/operational-models.json');

const readJson = async (path, fallback = null) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
};

const readJsonlDir = async (directory) => {
  try {
    const files = (await readdir(directory)).filter((file) => file.endsWith('.jsonl')).sort();
    const texts = await Promise.all(files.map((file) => readFile(resolve(directory, file), 'utf8')));
    return texts.flatMap((text) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const readObservations = async () => {
  const rows = await readJsonlDir(OBSERVATION_DIR);
  if (rows.length) return rows;
  try {
    return (await readFile(resolve(ROOT, 'data/ml/observations.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const unique = (values) => new Set(values.filter(Boolean));
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const daysBetween = (rows) => {
  const timestamps = rows.map((row) => Number(row.observedAt)).filter(Number.isFinite).sort((a, b) => a - b);
  return timestamps.length > 1 ? round((timestamps.at(-1) - timestamps[0]) / 86400000, 1) : 0;
};

const delayLabels = (rows) => rows.filter((row) => finite(row.officialDelaySeconds ?? row.reportedDelaySeconds) !== null);
const lineCounts = (rows) => Object.fromEntries([...unique(rows.map((row) => row.line))].sort().map((line) => [line, rows.filter((row) => row.line === line).length]));

const model = ({ id, name, group, algorithm, target, inputs, status, examples, holdoutExamples = 0, scores = null, blocker = null, evidence }) => ({
  id, name, group, algorithm, target, inputs, status,
  trainingExamples: examples,
  holdoutExamples,
  scores,
  blocker,
  evidence,
});

const rows = await readObservations();
const headwayEvents = await readJsonlDir(HEADWAY_DIR);
const incidents = await readJson(INCIDENTS_PATH, { incidents: [] });
const metrics = await readJson(DELAY_METRICS_PATH, {});
const labels = delayLabels(rows);
const recoveredHeadways = headwayEvents.filter((event) => event.eventStatus === 'recovered' && finite(event.recoveryDurationSeconds) !== null);
const platformObservations = rows.filter((row) => row.onStop === true || row.onStop === 'true');
const vehicleObservations = rows.filter((row) => row.vehicleId);
const observedDays = unique(rows.map((row) => Number.isFinite(Number(row.observedAt))
  ? new Date(Number(row.observedAt)).toISOString().slice(0, 10) : null));
const delayMetric = metrics.model || {};

const enoughDelayLabels = labels.length >= 150 && observedDays.size >= 2;
const enoughHeadway = headwayEvents.length >= 30;
const enoughRecovery = recoveredHeadways.length >= 10;
const evidence = `${rows.length} observations across ${observedDays.size} calendar day${observedDays.size === 1 ? '' : 's'}`;

const models = [
  model({ id: 'multi-horizon-delay', name: 'Multi-horizon delay', group: 'trainable-now', algorithm: 'horizon-specific ridge/quantile regression', target: 'final operator delay at 2, 5, 10 and 15 minutes', inputs: ['early reported delay', 'lead time', 'line', 'time of day', 'direction', 'incidents'], status: enoughDelayLabels ? 'candidate' : 'collecting-labels', examples: labels.length, holdoutExamples: delayMetric.sampleCount || 0, scores: delayMetric.maeMinutes == null ? null : { maeMinutes: delayMetric.maeMinutes, rmseMinutes: delayMetric.rmseMinutes }, blocker: enoughDelayLabels ? null : 'Needs at least two days and 150 labelled journeys.', evidence }),
  model({ id: 'next-station-eta', name: 'Next-station ETA', group: 'trainable-now', algorithm: 'calibrated ETA regression', target: 'operator-reported arrival countdown', inputs: ['seconds to real arrival', 'line', 'station', 'direction', 'position uncertainty', 'observation age'], status: vehicleObservations.length >= 150 ? 'candidate' : 'collecting-labels', examples: vehicleObservations.length, blocker: vehicleObservations.length >= 150 ? null : 'Needs repeated vehicle/station observations to measure ETA error.', evidence }),
  model({ id: 'dwell-time', name: 'Dwell time', group: 'trainable-now', algorithm: 'platform-stop duration model', target: 'platform arrival-to-departure duration', inputs: ['on-stop flag', 'station', 'line', 'time of day', 'vehicle identity'], status: platformObservations.length >= 100 ? 'candidate' : 'collecting-labels', examples: platformObservations.length, blocker: platformObservations.length >= 100 ? null : 'Needs repeated on-stop observations with stable vehicle IDs.', evidence }),
  model({ id: 'headway-bunching', name: 'Headway and bunching', group: 'trainable-now', algorithm: 'station-level event classifier', target: 'gap or bunching event in the next 20 minutes', inputs: ['station', 'line', 'direction', 'departure interval', 'recent event history'], status: enoughHeadway ? 'candidate' : 'collecting-labels', examples: headwayEvents.length, blocker: enoughHeadway ? null : 'Needs more station-level headway event lifecycles.', evidence }),
  model({ id: 'recovery-duration', name: 'Delay recovery duration', group: 'trainable-now', algorithm: 'survival/quantile duration model', target: 'time from incident or headway event to recovery', inputs: ['event type', 'line', 'severity', 'incident context', 'headway duration'], status: enoughRecovery ? 'candidate' : 'collecting-labels', examples: recoveredHeadways.length, blocker: enoughRecovery ? null : 'Needs recovered event labels; current archive has too few.', evidence }),
  model({ id: 'disruption-impact', name: 'Disruption impact', group: 'trainable-now', algorithm: 'incident-impact regression', target: 'added delay and affected service', inputs: ['incident line/stations', 'incident severity', 'delay observations', 'headway events'], status: enoughDelayLabels && incidents.incidents?.length ? 'candidate' : 'collecting-labels', examples: labels.length, blocker: enoughDelayLabels && incidents.incidents?.length ? null : 'Needs overlapping incident episodes and final delay labels.', evidence }),
  model({ id: 'delay-severity', name: 'Delay severity classifier', group: 'trainable-now', algorithm: 'threshold classifier / gradient model candidate', target: 'on-time, minor, major or severe', inputs: ['reported delay', 'incident flags', 'line', 'station'], status: enoughDelayLabels ? 'candidate' : 'collecting-labels', examples: labels.length, holdoutExamples: delayMetric.sampleCount || 0, scores: delayMetric.delayedThreeMinutes ? { accuracyPercent: delayMetric.delayedThreeMinutes.accuracyPercent, f1: delayMetric.delayedThreeMinutes.f1 } : null, blocker: enoughDelayLabels ? null : 'Needs labelled delay outcomes.', evidence }),
  model({ id: 'delay-bands', name: 'Probabilistic delay bands', group: 'trainable-now', algorithm: 'empirical quantile model', target: 'low, typical and high delay quantiles', inputs: ['historical delay distribution', 'line', 'station', 'time of day'], status: enoughDelayLabels ? 'candidate' : 'collecting-labels', examples: labels.length, scores: delayMetric.withinOneMinutePercent == null ? null : { withinOneMinutePercent: delayMetric.withinOneMinutePercent }, blocker: enoughDelayLabels ? null : 'Needs a representative delay distribution.', evidence }),
  model({ id: 'route-reliability', name: 'Route reliability', group: 'trainable-now', algorithm: 'line/station reliability estimator', target: 'probability of on-time route completion', inputs: ['delay labels', 'incident episodes', 'line and station'], status: enoughDelayLabels ? 'candidate' : 'collecting-labels', examples: labels.length, blocker: enoughDelayLabels ? null : 'Needs historical route outcomes.', evidence }),
  model({ id: 'cancellation-risk', name: 'Cancellation and short-turn risk', group: 'trainable-now', algorithm: 'missing-service classifier', target: 'cancelled or short-turned service', inputs: ['scheduled service', 'observed departures', 'gaps', 'official notices'], status: 'collecting-labels', examples: 0, blocker: 'The current archive does not yet retain a complete scheduled-versus-observed service label.', evidence }),
  model({ id: 'crowding-forecast', name: 'Crowding forecast', group: 'needs-labels', algorithm: 'demand regression', target: 'passenger load or crowding level', inputs: ['passenger counts', 'service intervals', 'time', 'events', 'weather'], status: 'collecting-labels', examples: 0, blocker: 'No validated passenger-count label is available in the current public feed.', evidence }),
  model({ id: 'weather-impact', name: 'Weather impact', group: 'needs-labels', algorithm: 'weather-to-delay regression', target: 'additional delay attributable to weather', inputs: ['weather history', 'delay labels', 'line', 'incident context'], status: 'collecting-labels', examples: 0, blocker: 'Weather history is not archived alongside the operational labels yet.', evidence }),
  model({ id: 'event-demand', name: 'Event-demand forecast', group: 'needs-labels', algorithm: 'event-demand regression', target: 'demand pressure around events', inputs: ['event calendar', 'ridership/load labels', 'service intervals'], status: 'collecting-labels', examples: 0, blocker: 'Event text is available, but attendance or ridership labels are not.', evidence }),
  model({ id: 'transfer-success', name: 'Transfer success probability', group: 'needs-labels', algorithm: 'connection survival model', target: 'whether a connection is caught', inputs: ['actual arrival', 'actual departure', 'walking margin', 'station transfer graph'], status: 'collecting-labels', examples: 0, blocker: 'The app has transfer margins but no observed passenger/connection outcome label.', evidence }),
  model({ id: 'predictive-anomaly', name: 'Predictive anomaly detection', group: 'trainable-now', algorithm: 'unsupervised robust baseline', target: 'unusual gap, bunching or feed behaviour', inputs: ['historical interval distributions', 'feed freshness', 'position confidence'], status: rows.length >= 100 ? 'candidate' : 'collecting-labels', examples: rows.length, blocker: rows.length >= 100 ? null : 'Needs a larger normal-behaviour baseline.', evidence }),
  model({ id: 'uncertainty-calibration', name: 'Uncertainty calibration', group: 'trainable-now', algorithm: 'residual/coverage calibration', target: 'prediction interval coverage', inputs: ['prediction residuals', 'feed age', 'position uncertainty', 'line history'], status: enoughDelayLabels ? 'candidate' : 'collecting-labels', examples: labels.length, blocker: enoughDelayLabels ? null : 'Needs enough scored residuals to calibrate coverage.', evidence }),
  model({ id: 'sbahn-live', name: 'S-Bahn live prediction', group: 'blocked', algorithm: 'real-time train-run model', target: 'actual S-Bahn delay and vehicle position', inputs: ['ÖBB real-time train-run positions', 'actual arrival/departure labels'], status: 'blocked', examples: 0, blocker: 'The current ÖBB source provides timetable/open-data archives, not a live vehicle-delay feed for this app.', evidence }),
];

const candidateCount = models.filter((item) => item.status === 'candidate').length;
const collectingCount = models.filter((item) => item.status === 'collecting-labels').length;
const blockedCount = models.filter((item) => item.status === 'blocked').length;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  data: {
    observationRows: rows.length,
    labelledDelayRows: labels.length,
    headwayEvents: headwayEvents.length,
    recoveredHeadwayEvents: recoveredHeadways.length,
    calendarDays: observedDays.size,
    coverageDays: daysBetween(rows),
    lineCounts: lineCounts(rows),
  },
  summary: { total: models.length, candidate: candidateCount, collectingLabels: collectingCount, blocked: blockedCount },
  models,
};

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary));

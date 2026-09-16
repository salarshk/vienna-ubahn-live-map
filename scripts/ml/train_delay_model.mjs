#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { incidentFeaturesAt } from './incident_features.mjs';
import { replayOnlineCalibration } from './online_calibrator.mjs';
import { trainingStageFor } from './training_policy.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const INPUT_DIR = resolve(ROOT, process.env.DELAY_OBSERVATIONS_DIR || 'data/ml/observations');
const MODEL_PATH = resolve(ROOT, process.env.DELAY_MODEL_PATH || 'public/ml/delay-model.json');
const METRICS_PATH = resolve(ROOT, process.env.DELAY_METRICS_PATH || 'public/ml/delay-metrics.json');
const INCIDENTS_PATH = resolve(ROOT, process.env.DELAY_INCIDENTS_PATH || 'data/ml/ubahn-incidents.json');
const REQUIREMENTS = {
  preliminary: {
    minimumDays: Number(process.env.DELAY_PRELIMINARY_MIN_DAYS || 2),
    minimumCoverageHours: Number(process.env.DELAY_PRELIMINARY_MIN_COVERAGE_HOURS || 36),
    minimumExamples: Number(process.env.DELAY_PRELIMINARY_MIN_EXAMPLES || 150),
    minimumTestExamples: Number(process.env.DELAY_PRELIMINARY_MIN_TEST_EXAMPLES || 30),
  },
  validated: {
    minimumDays: Number(process.env.DELAY_MIN_DAYS || 7),
    minimumCoverageHours: Number(process.env.DELAY_MIN_COVERAGE_HOURS || 144),
    minimumExamples: Number(process.env.DELAY_MIN_EXAMPLES || 500),
    minimumTestExamples: Number(process.env.DELAY_MIN_TEST_EXAMPLES || 100),
  },
};
const DELAY_THRESHOLD_MINUTES = 3;
const ONLINE_MIN_EXAMPLES = Number(process.env.DELAY_ONLINE_MIN_EXAMPLES || 30);
const LINES = ['U1', 'U2', 'U3', 'U4', 'U6'];

const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));
const officialDelaySeconds = (row) => {
  const value = Number(row?.officialDelaySeconds ?? row?.reportedDelaySeconds);
  return Number.isFinite(value) ? value : null;
};

const readRows = async () => {
  try {
    const files = (await readdir(INPUT_DIR)).filter((file) => file.endsWith('.jsonl')).sort();
    const texts = await Promise.all(files.map((file) => readFile(resolve(INPUT_DIR, file), 'utf8')));
    return texts.flatMap((text) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const readIncidentArchive = async () => {
  try {
    return JSON.parse(await readFile(INCIDENTS_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const makeExamples = (rows) => {
  const byEvent = new Map();
  for (const row of rows) {
    if (!row.eventKey || !Number.isFinite(row.observedAt)) continue;
    if (!byEvent.has(row.eventKey)) byEvent.set(row.eventKey, []);
    byEvent.get(row.eventKey).push(row);
  }

  const examples = [];
  for (const eventRows of byEvent.values()) {
    eventRows.sort((a, b) => a.observedAt - b.observedAt);
    const finalCandidates = eventRows.filter((row) => row.secondsToReal >= -120 && row.secondsToReal <= 150
      && officialDelaySeconds(row) !== null);
    if (!finalCandidates.length) continue;
    const finalRow = finalCandidates.reduce((best, row) => (
      Math.abs(row.secondsToReal) < Math.abs(best.secondsToReal) ? row : best
    ));
    const earlyCandidates = eventRows.filter((row) => row.secondsToReal >= 240 && row.secondsToReal <= 900
      && officialDelaySeconds(row) !== null);
    if (!earlyCandidates.length) continue;
    const featureRow = earlyCandidates.reduce((best, row) => (
      Math.abs(row.secondsToReal - 480) < Math.abs(best.secondsToReal - 480) ? row : best
    ));
    examples.push({
      ...featureRow,
      targetDelayMinutes: clamp(officialDelaySeconds(finalRow) / 60, -2, 30),
      currentDelayMinutes: clamp(officialDelaySeconds(featureRow) / 60, -2, 30),
      targetLabelSource: finalRow.delaySource || 'wiener-linien-timeReal-minus-timePlanned',
      officialLabel: finalRow.delaySource === 'wiener-linien-timeReal-minus-timePlanned'
        || Number.isFinite(Number(finalRow.officialDelaySeconds)),
      plannedTimestamp: Date.parse(featureRow.plannedTime),
      featureObservedAt: featureRow.observedAt,
      labelObservedAt: finalRow.observedAt,
    });
  }
  return examples.filter((example) => Number.isFinite(example.plannedTimestamp)
      && Number.isFinite(example.featureObservedAt) && Number.isFinite(example.labelObservedAt))
    .sort((a, b) => a.plannedTimestamp - b.plannedTimestamp || a.eventKey.localeCompare(b.eventKey));
};

const featureNames = [
  'intercept', 'currentDelayMinutes', 'leadMinutes', 'hourSin', 'hourCos',
  'weekdaySin', 'weekdayCos', 'trafficJam', 'directionH',
  'activeIncidentCount', 'incidentPriority', 'delayRelatedIncident',
  ...LINES.map((line) => `line_${line}`),
];

const rawFeatures = (example) => {
  const planned = new Date(example.plannedTimestamp);
  const hour = planned.getUTCHours() + planned.getUTCMinutes() / 60;
  const weekday = planned.getUTCDay();
  return [
    1,
    example.currentDelayMinutes,
    clamp(example.secondsToReal / 60, 0, 30),
    Math.sin(2 * Math.PI * hour / 24),
    Math.cos(2 * Math.PI * hour / 24),
    Math.sin(2 * Math.PI * weekday / 7),
    Math.cos(2 * Math.PI * weekday / 7),
    example.trafficJam ? 1 : 0,
    example.direction === 'H' ? 1 : 0,
    clamp(Number(example.activeIncidentCount) || 0, 0, 10),
    clamp(Number(example.incidentPriority) || 0, 0, 10),
    example.delayRelatedIncident ? 1 : 0,
    ...LINES.map((line) => example.line === line ? 1 : 0),
  ];
};

const standardisedIndices = new Set([1, 2, 9, 10]);

const calculateScaling = (examples) => {
  const vectors = examples.map(rawFeatures);
  return featureNames.map((_, index) => {
    if (!standardisedIndices.has(index)) return { mean: 0, scale: 1 };
    const mean = vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length;
    const variance = vectors.reduce((sum, vector) => sum + (vector[index] - mean) ** 2, 0) / vectors.length;
    return { mean, scale: Math.sqrt(variance) || 1 };
  });
};

const vectorise = (example, scaling) => rawFeatures(example).map((value, index) => (
  (value - scaling[index].mean) / scaling[index].scale
));

const solveLinearSystem = (matrix, values) => {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-10) throw new Error('Delay model matrix is singular');
    for (let cell = column; cell <= size; cell += 1) augmented[column][cell] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let cell = column; cell <= size; cell += 1) {
        augmented[row][cell] -= factor * augmented[column][cell];
      }
    }
  }
  return augmented.map((row) => row[size]);
};

const fitRidgeTarget = (examples, scaling, lambda = 2, targetFor = (example) => example.targetDelayMinutes) => {
  const size = featureNames.length;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  const values = Array(size).fill(0);
  for (const example of examples) {
    const vector = vectorise(example, scaling);
    for (let row = 0; row < size; row += 1) {
      values[row] += vector[row] * targetFor(example);
      for (let column = 0; column < size; column += 1) {
        matrix[row][column] += vector[row] * vector[column];
      }
    }
  }
  for (let index = 1; index < size; index += 1) matrix[index][index] += lambda;
  return solveLinearSystem(matrix, values);
};

const fitRidge = (examples, scaling, lambda = 2) => fitRidgeTarget(examples, scaling, lambda);

const predict = (example, scaling, weights) => clamp(
  vectorise(example, scaling).reduce((sum, value, index) => sum + value * weights[index], 0),
  -2,
  30,
);

/**
 * The live estimate is already a strong prediction.  Learning the residual
 * (final delay minus the current official estimate) is therefore a safer and
 * usually more accurate formulation than predicting the final delay from
 * scratch.  The blend is tuned on a later slice of the training period only;
 * the final test days remain completely untouched.
 */
const fitResidualRidge = (examples, scaling, { lambda = 2, blend = 1 } = {}) => {
  const weights = fitRidgeTarget(
    examples,
    scaling,
    lambda,
    (example) => example.targetDelayMinutes - example.currentDelayMinutes,
  );
  const predictor = (example) => clamp(
    example.currentDelayMinutes + blend * vectorise(example, scaling)
      .reduce((sum, value, index) => sum + value * weights[index], 0),
    -2,
    30,
  );
  predictor.weights = weights;
  return predictor;
};

const tuneResidualRidge = (training, scaling) => {
  const dates = [...new Set(training.map((example) => (
    new Date(example.plannedTimestamp).toISOString().slice(0, 10)
  )))].sort();
  const calibrationDays = new Set(dates.slice(-Math.max(1, Math.ceil(dates.length * 0.2))));
  const fit = training.filter((example) => !calibrationDays.has(
    new Date(example.plannedTimestamp).toISOString().slice(0, 10),
  ));
  const calibration = training.filter((example) => calibrationDays.has(
    new Date(example.plannedTimestamp).toISOString().slice(0, 10),
  ));
  // If the training window is short, retain a conservative default rather
  // than tuning on the same observations that will be refit and scored.
  if (fit.length < 30 || calibration.length < 15) {
    return { lambda: 2, blend: 0.75 };
  }
  const candidates = [
    [0.25, 0.5], [0.5, 0.5], [1, 0.5], [2, 0.5], [5, 0.5], [10, 0.5],
    [0.25, 0.75], [0.5, 0.75], [1, 0.75], [2, 0.75], [5, 0.75], [10, 0.75],
    [0.25, 1], [0.5, 1], [1, 1], [2, 1], [5, 1], [10, 1],
  ];
  const actual = calibration.map((example) => example.targetDelayMinutes);
  const scored = candidates.map(([lambda, blend]) => {
    const predictor = fitResidualRidge(fit, scaling, { lambda, blend });
    const score = metricsFor(actual, calibration.map(predictor));
    return { lambda, blend, score };
  });
  return scored.sort((left, right) => (
    left.score.maeMinutes - right.score.maeMinutes
      || left.score.rmseMinutes - right.score.rmseMinutes
  ))[0] || { lambda: 2, blend: 0.75 };
};

const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
const softThreshold = (value, amount) => value > amount ? value - amount : value < -amount ? value + amount : 0;

/** Elastic net gives the comparison a sparse, regularised linear alternative. */
const fitElasticNet = (examples, scaling, { l1 = 0.08, l2 = 1.2, iterations = 80 } = {}) => {
  const vectors = examples.map((example) => vectorise(example, scaling));
  const targets = examples.map((example) => example.targetDelayMinutes);
  const weights = Array(featureNames.length).fill(0);
  const predictions = Array(targets.length).fill(0);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let feature = 0; feature < featureNames.length; feature += 1) {
      let rho = 0;
      let denominator = feature === 0 ? 0 : l2;
      for (let row = 0; row < vectors.length; row += 1) {
        const residual = targets[row] - (predictions[row] - vectors[row][feature] * weights[feature]);
        rho += vectors[row][feature] * residual;
        denominator += vectors[row][feature] ** 2;
      }
      const next = feature === 0 ? rho / Math.max(1e-9, denominator) : softThreshold(rho, l1) / Math.max(1e-9, denominator);
      const delta = next - weights[feature];
      if (!delta) continue;
      weights[feature] = next;
      for (let row = 0; row < predictions.length; row += 1) predictions[row] += vectors[row][feature] * delta;
    }
  }
  return (example) => clamp(dot(vectorise(example, scaling), weights), -2, 30);
};

const seededRandom = (seed = 42) => {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const buildRegressionTree = (vectors, targets, { depth = 0, maxDepth = 3, minLeaf = 8, rng = seededRandom() } = {}) => {
  const leaf = { value: mean(targets) };
  if (depth >= maxDepth || vectors.length < minLeaf * 2) return leaf;
  const parentMean = leaf.value;
  const parentError = targets.reduce((sum, target) => sum + (target - parentMean) ** 2, 0);
  if (parentError < 1e-8) return leaf;
  const featurePool = [...Array(featureNames.length).keys()].filter((feature) => feature !== 0);
  for (let index = featurePool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [featurePool[index], featurePool[swap]] = [featurePool[swap], featurePool[index]];
  }
  const featuresToTry = featurePool.slice(0, Math.max(2, Math.ceil(Math.sqrt(featurePool.length))));
  let best = null;
  for (const feature of featuresToTry) {
    const values = [...new Set(vectors.map((vector) => vector[feature]))].sort((a, b) => a - b);
    if (values.length < 2) continue;
    const step = Math.max(1, Math.floor(values.length / 12));
    for (let index = step; index < values.length; index += step) {
      const threshold = (values[index - 1] + values[index]) / 2;
      const left = [];
      const right = [];
      for (let row = 0; row < vectors.length; row += 1) {
        (vectors[row][feature] <= threshold ? left : right).push(row);
      }
      if (left.length < minLeaf || right.length < minLeaf) continue;
      const leftMean = mean(left.map((row) => targets[row]));
      const rightMean = mean(right.map((row) => targets[row]));
      const error = left.reduce((sum, row) => sum + (targets[row] - leftMean) ** 2, 0)
        + right.reduce((sum, row) => sum + (targets[row] - rightMean) ** 2, 0);
      if (!best || error < best.error) best = { feature, threshold, left, right, error };
    }
  }
  if (!best || best.error >= parentError) return leaf;
  return {
    feature: best.feature,
    threshold: best.threshold,
    left: buildRegressionTree(best.left.map((row) => vectors[row]), best.left.map((row) => targets[row]), { depth: depth + 1, maxDepth, minLeaf, rng }),
    right: buildRegressionTree(best.right.map((row) => vectors[row]), best.right.map((row) => targets[row]), { depth: depth + 1, maxDepth, minLeaf, rng }),
  };
};

const predictTree = (tree, vector) => {
  if (Number.isFinite(tree.value)) return tree.value;
  return predictTree(vector[tree.feature] <= tree.threshold ? tree.left : tree.right, vector);
};

/** Bagged shallow trees provide a nonlinear alternative without a runtime dependency. */
const fitRandomForest = (examples, scaling, { trees = 32, maxDepth = 3, minLeaf = 8 } = {}) => {
  const vectors = examples.map((example) => vectorise(example, scaling));
  const targets = examples.map((example) => example.targetDelayMinutes);
  const rng = seededRandom(20260916);
  const forest = [];
  for (let tree = 0; tree < trees; tree += 1) {
    const sampleVectors = [];
    const sampleTargets = [];
    for (let row = 0; row < vectors.length; row += 1) {
      const sampled = Math.floor(rng() * vectors.length);
      sampleVectors.push(vectors[sampled]);
      sampleTargets.push(targets[sampled]);
    }
    forest.push(buildRegressionTree(sampleVectors, sampleTargets, { maxDepth, minLeaf, rng }));
  }
  return (example) => clamp(mean(forest.map((tree) => predictTree(tree, vectorise(example, scaling)))), -2, 30);
};

/** Gradient boosting fits shallow trees to residuals, capturing nonlinear interactions. */
const fitGradientBoosting = (examples, scaling, { rounds = 40, learningRate = 0.05, maxDepth = 2, minLeaf = 8 } = {}) => {
  const vectors = examples.map((example) => vectorise(example, scaling));
  const targets = examples.map((example) => example.targetDelayMinutes);
  const base = mean(targets);
  const current = Array(targets.length).fill(base);
  const rng = seededRandom(20260917);
  const trees = [];
  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    const residual = targets.map((target, index) => target - current[index]);
    const tree = buildRegressionTree(vectors, residual, { maxDepth, minLeaf, rng });
    trees.push(tree);
    for (let row = 0; row < current.length; row += 1) current[row] += learningRate * predictTree(tree, vectors[row]);
  }
  return (example) => clamp(base + trees.reduce((sum, tree) => sum + learningRate * predictTree(tree, vectorise(example, scaling)), 0), -2, 30);
};

const fitKnn = (examples, scaling, { neighbours = 25 } = {}) => {
  const vectors = examples.map((example) => vectorise(example, scaling));
  return (example) => {
    const vector = vectorise(example, scaling);
    const nearest = vectors.map((candidate, index) => ({
      distance: candidate.slice(1).reduce((sum, value, feature) => sum + (value - vector[feature + 1]) ** 2, 0),
      target: examples[index].targetDelayMinutes,
    })).sort((a, b) => a.distance - b.distance).slice(0, Math.min(neighbours, vectors.length));
    return clamp(mean(nearest.map((item) => item.target)), -2, 30);
  };
};

const metricsFor = (actual, predicted) => {
  const count = actual.length;
  const errors = actual.map((value, index) => predicted[index] - value);
  const absolute = errors.map(Math.abs);
  const meanActual = actual.reduce((sum, value) => sum + value, 0) / count;
  const totalVariance = actual.reduce((sum, value) => sum + (value - meanActual) ** 2, 0);
  const residual = errors.reduce((sum, value) => sum + value ** 2, 0);
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  actual.forEach((value, index) => {
    const actualDelayed = value >= DELAY_THRESHOLD_MINUTES;
    const predictedDelayed = predicted[index] >= DELAY_THRESHOLD_MINUTES;
    if (actualDelayed && predictedDelayed) truePositive += 1;
    else if (!actualDelayed && !predictedDelayed) trueNegative += 1;
    else if (!actualDelayed && predictedDelayed) falsePositive += 1;
    else falseNegative += 1;
  });
  const precision = truePositive / Math.max(1, truePositive + falsePositive);
  const recall = truePositive / Math.max(1, truePositive + falseNegative);
  return {
    sampleCount: count,
    maeMinutes: round(absolute.reduce((sum, value) => sum + value, 0) / count),
    rmseMinutes: round(Math.sqrt(residual / count)),
    rSquared: round(totalVariance ? 1 - residual / totalVariance : 0, 3),
    withinOneMinutePercent: round(100 * absolute.filter((value) => value <= 1).length / count, 1),
    withinTwoMinutesPercent: round(100 * absolute.filter((value) => value <= 2).length / count, 1),
    delayedThreeMinutes: {
      accuracyPercent: round(100 * (truePositive + trueNegative) / count, 1),
      precision: round(precision, 3),
      recall: round(recall, 3),
      f1: round(2 * precision * recall / Math.max(1e-9, precision + recall), 3),
      confusionMatrix: { truePositive, trueNegative, falsePositive, falseNegative },
    },
  };
};

const incidentArchive = await readIncidentArchive();
const rawRows = await readRows();
const rows = rawRows.map((row) => {
  if (Number.isFinite(Number(row.activeIncidentCount))) return row;
  return {
    ...row,
    ...incidentFeaturesAt(incidentArchive?.incidents, row.line, Number(row.observedAt)),
  };
});
const examples = makeExamples(rows);
const onlineReplay = replayOnlineCalibration(examples, { minimumExamples: ONLINE_MIN_EXAMPLES });
const uniqueDates = [...new Set(rows.map((row) => new Date(row.observedAt).toISOString().slice(0, 10)))].sort();
const firstObservationMs = rows.reduce((earliest, row) => Math.min(earliest, row.observedAt), Infinity);
const lastObservationMs = rows.reduce((latest, row) => Math.max(latest, row.observedAt), -Infinity);
const firstObservation = Number.isFinite(firstObservationMs) ? new Date(firstObservationMs).toISOString() : null;
const lastObservation = Number.isFinite(lastObservationMs) ? new Date(lastObservationMs).toISOString() : null;
const coverageHours = Number.isFinite(firstObservationMs) && Number.isFinite(lastObservationMs)
  ? round((lastObservationMs - firstObservationMs) / 3600000, 1) : 0;
const exampleDates = [...new Set(examples.map((example) => (
  new Date(example.plannedTimestamp).toISOString().slice(0, 10)
)))].sort();
const testDayCount = Math.max(1, Math.ceil(exampleDates.length * 0.2));
const testDates = new Set(exampleDates.slice(-testDayCount));
const candidateTraining = examples.filter((example) => !testDates.has(
  new Date(example.plannedTimestamp).toISOString().slice(0, 10)
));
const candidateTest = examples.filter((example) => testDates.has(
  new Date(example.plannedTimestamp).toISOString().slice(0, 10)
));
const validationStage = trainingStageFor({
  dataDays: uniqueDates.length,
  coverageHours,
  examples: examples.length,
  testExamples: candidateTest.length,
}, REQUIREMENTS);

const common = {
  schemaVersion: 1,
  target: 'Final Wiener Linien reported delay, in minutes, near departure',
  observationCount: rows.length,
  labelledJourneyCount: examples.length,
  dataDays: uniqueDates.length,
  coverageHours,
  firstObservation,
  lastObservation,
  requirements: {
    ...REQUIREMENTS.validated,
    preliminary: REQUIREMENTS.preliminary,
    validated: REQUIREMENTS.validated,
  },
  incidentContext: {
    source: incidentArchive?.sourceCatalogUrl || incidentArchive?.sourceUrl || 'Live Wiener Linien traffic information only',
    archiveImported: Boolean(incidentArchive),
    archivedUbahnEpisodes: incidentArchive?.ubahnEpisodeCount || 0,
    sourceExportDate: incidentArchive?.sourceExportDate || null,
    features: ['active incident count', 'highest incident priority', 'delay-related incident flag'],
  },
  labelQuality: {
    officialDelayField: 'officialDelaySeconds',
    source: 'Wiener Linien timeReal minus timePlanned near departure',
    officialLabelledJourneys: examples.filter((example) => example.officialLabel).length,
    fallbackLabelledJourneys: examples.filter((example) => !example.officialLabel).length,
  },
  monitoring: {
    cadence: 'Every 10 minutes when the collector workflow runs',
    rollbackPolicy: 'Disable ML predictions when the candidate is stale, invalid, or does not beat the live-estimate baseline.',
    maxAgeHours: 36,
    maxMaeMinutes: 10,
    maxRmseMinutes: 15,
  },
};

const onlineReady = onlineReplay.status === 'ready';
const onlineModelMetrics = onlineReady ? metricsFor(onlineReplay.actual, onlineReplay.predictions) : null;
const onlineBaselineMetrics = onlineReady ? metricsFor(onlineReplay.actual, onlineReplay.baseline) : null;
const onlineDeployed = onlineReady && onlineModelMetrics.maeMinutes < onlineBaselineMetrics.maeMinutes;
const onlineCalibrationModel = {
  status: onlineReplay.status,
  algorithm: 'prequential-hierarchical-calibration',
  experimental: true,
  scoredJourneyCount: onlineReplay.scoredJourneyCount,
  minimumExamples: ONLINE_MIN_EXAMPLES,
  deployed: onlineDeployed,
  predictionRangeMinutes: [-2, 30],
  state: onlineReplay.state,
};
const onlineCalibrationMetrics = {
  status: onlineReplay.status,
  experimental: true,
  scoredJourneyCount: onlineReplay.scoredJourneyCount,
  minimumExamples: ONLINE_MIN_EXAMPLES,
  evaluationMethod: 'Prequential: every prediction is recorded before its final label is available; the label is used only for later predictions.',
  model: onlineModelMetrics,
  currentEstimateBaseline: onlineBaselineMetrics,
  deployment: {
    deployed: onlineDeployed,
    rule: `Enable online predictions after ${ONLINE_MIN_EXAMPLES} scored journeys only when their MAE beats the unadjusted live estimate.`,
  },
};

let model;
let metrics;
if (validationStage === 'collecting') {
  model = { ...common, status: 'collecting', trainedAt: null, deployed: false, onlineCalibration: onlineCalibrationModel };
  metrics = {
    ...common,
    status: 'collecting',
    message: `Collecting at least ${REQUIREMENTS.preliminary.minimumCoverageHours} hours across ${REQUIREMENTS.preliminary.minimumDays} days and ${REQUIREMENTS.preliminary.minimumExamples} labelled journeys before publishing a preliminary score.`,
    leakageControl: 'One early observation per journey; later near-departure observation becomes its label.',
    onlineCalibration: onlineCalibrationMetrics,
    monitoring: common.monitoring,
  };
} else {
  const training = candidateTraining;
  const test = candidateTest;
  const scaling = calculateScaling(training);
  const weights = fitRidge(training, scaling);
  const predictions = test.map((example) => predict(example, scaling, weights));
  const actual = test.map((example) => example.targetDelayMinutes);
  const baseline = test.map((example) => example.currentDelayMinutes);
  const modelMetrics = metricsFor(actual, predictions);
  const baselineMetrics = metricsFor(actual, baseline);
  const residualTuning = tuneResidualRidge(training, scaling);
  const residualPredictor = fitResidualRidge(training, scaling, residualTuning);
  const alternativePredictors = [
    { id: 'ridge-regression', name: 'Ridge regression', complexity: 'linear regularized', predict: (example) => predict(example, scaling, weights) },
    {
      id: 'residual-ridge-ensemble',
      name: 'Residual ridge ensemble',
      complexity: `baseline correction, λ=${residualTuning.lambda}, blend=${residualTuning.blend}`,
      predict: residualPredictor,
      runtime: {
        algorithm: 'residual-ridge-ensemble',
        lambda: residualTuning.lambda,
        blend: residualTuning.blend,
      },
    },
    { id: 'elastic-net', name: 'Elastic net', complexity: 'sparse regularized linear', predict: fitElasticNet(training, scaling) },
    { id: 'random-forest', name: 'Random forest', complexity: '32 bagged depth-3 trees', predict: fitRandomForest(training, scaling) },
    { id: 'gradient-boosting', name: 'Gradient boosting', complexity: '40 residual depth-2 trees', predict: fitGradientBoosting(training, scaling) },
    { id: 'knn', name: 'K-nearest neighbours', complexity: '25-neighbour distance model', predict: fitKnn(training, scaling) },
  ];
  const modelComparisons = alternativePredictors.map((candidate) => {
    const candidatePredictions = test.map(candidate.predict);
    const candidateMetrics = metricsFor(actual, candidatePredictions);
    return {
      id: candidate.id,
      name: candidate.name,
      complexity: candidate.complexity,
      metrics: candidateMetrics,
      beatsLiveBaseline: candidateMetrics.maeMinutes < baselineMetrics.maeMinutes,
      deployed: false,
    };
  });
  const bestAlternative = [...modelComparisons].sort((a, b) => a.metrics.maeMinutes - b.metrics.maeMinutes)[0];
  // Only candidates with a serialised browser implementation can be promoted.
  // At present that is the residual ridge ensemble; the other alternatives
  // remain useful research comparisons until their runtime format is added.
  const winningCandidate = modelComparisons.find((candidate) => (
    candidate.beatsLiveBaseline && candidate.id === 'residual-ridge-ensemble'
  ));
  const selectedCandidate = winningCandidate
    ? alternativePredictors.find((candidate) => candidate.id === winningCandidate.id)
    : null;
  const deployed = Boolean(winningCandidate);
  const trainedAt = new Date().toISOString();
  const cutoff = new Date(test[0].plannedTimestamp).toISOString();
  model = {
    ...common,
    status: 'ready',
    validationStage,
    algorithm: selectedCandidate?.runtime?.algorithm || 'ridge-regression',
    trainedAt,
    deployed,
    trainedThrough: new Date(training.at(-1).plannedTimestamp).toISOString(),
    featureNames,
    scaling: scaling.map(({ mean, scale }) => ({ mean: round(mean, 8), scale: round(scale, 8) })),
    weights: (selectedCandidate?.predict.weights || weights).map((weight) => round(weight, 8)),
    selectedModel: selectedCandidate?.id || 'ridge-regression',
    selectedModelParameters: selectedCandidate?.runtime || null,
    predictionRangeMinutes: [-2, 30],
    modelComparisons: modelComparisons.map((candidate) => ({
      ...candidate,
      deployed: candidate.id === selectedCandidate?.id,
    })),
    bestAlternative: bestAlternative?.id || null,
    onlineCalibration: onlineCalibrationModel,
  };
  metrics = {
    ...common,
    status: 'ready',
    validationStage,
    trainedAt,
    algorithm: 'Ridge regression',
    split: {
      method: 'Chronological split by whole calendar days; the newest 20% of days are test-only',
      trainingExamples: training.length,
      testExamples: test.length,
      testPeriodStarts: cutoff,
    },
    model: winningCandidate ? winningCandidate.metrics : modelMetrics,
    modelComparisons: modelComparisons.map((candidate) => ({
      ...candidate,
      deployed: candidate.id === selectedCandidate?.id,
    })),
    bestAlternative: bestAlternative ? {
      id: bestAlternative.id,
      name: bestAlternative.name,
      maeMinutes: bestAlternative.metrics.maeMinutes,
      rmseMinutes: bestAlternative.metrics.rmseMinutes,
      beatsLiveBaseline: bestAlternative.beatsLiveBaseline,
    } : null,
    currentEstimateBaseline: baselineMetrics,
    deployment: {
      deployed: Boolean(winningCandidate),
      rule: 'Publish live predictions only when test MAE beats carrying forward the early operator estimate.',
    },
    monitoring: {
      ...common.monitoring,
      evaluatedAt: trainedAt,
      beatsBaseline: Boolean(winningCandidate),
      rollbackActive: !winningCandidate,
    },
    delayClassificationThresholdMinutes: DELAY_THRESHOLD_MINUTES,
    labelCaveat: 'The target is the official Wiener Linien timeReal minus timePlanned near departure, not an independent GPS ground truth.',
    promotion: validationStage === 'validated'
      ? 'Validated automatically after meeting the seven-day safeguards.'
      : 'Preliminary result; it will be replaced automatically after meeting the seven-day safeguards.',
    onlineCalibration: onlineCalibrationMetrics,
  };
}

await mkdir(dirname(MODEL_PATH), { recursive: true });
await mkdir(dirname(METRICS_PATH), { recursive: true });
await writeFile(MODEL_PATH, `${JSON.stringify(model, null, 2)}\n`);
await writeFile(METRICS_PATH, `${JSON.stringify(metrics, null, 2)}\n`);
console.log(JSON.stringify(metrics, null, 2));

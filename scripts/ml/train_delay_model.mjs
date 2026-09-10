#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const INPUT_DIR = resolve(ROOT, process.env.DELAY_OBSERVATIONS_DIR || 'data/ml/observations');
const MODEL_PATH = resolve(ROOT, process.env.DELAY_MODEL_PATH || 'public/ml/delay-model.json');
const METRICS_PATH = resolve(ROOT, process.env.DELAY_METRICS_PATH || 'public/ml/delay-metrics.json');
const MIN_DAYS = Number(process.env.DELAY_MIN_DAYS || 7);
const MIN_EXAMPLES = Number(process.env.DELAY_MIN_EXAMPLES || 500);
const MIN_TEST_EXAMPLES = Number(process.env.DELAY_MIN_TEST_EXAMPLES || 100);
const DELAY_THRESHOLD_MINUTES = 3;
const LINES = ['U1', 'U2', 'U3', 'U4', 'U6'];

const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));

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
    const finalCandidates = eventRows.filter((row) => row.secondsToReal >= -120 && row.secondsToReal <= 150);
    if (!finalCandidates.length) continue;
    const finalRow = finalCandidates.reduce((best, row) => (
      Math.abs(row.secondsToReal) < Math.abs(best.secondsToReal) ? row : best
    ));
    const earlyCandidates = eventRows.filter((row) => row.secondsToReal >= 240 && row.secondsToReal <= 900);
    if (!earlyCandidates.length) continue;
    const featureRow = earlyCandidates.reduce((best, row) => (
      Math.abs(row.secondsToReal - 480) < Math.abs(best.secondsToReal - 480) ? row : best
    ));
    examples.push({
      ...featureRow,
      targetDelayMinutes: clamp(finalRow.reportedDelaySeconds / 60, -2, 30),
      currentDelayMinutes: clamp(featureRow.reportedDelaySeconds / 60, -2, 30),
      plannedTimestamp: Date.parse(featureRow.plannedTime),
    });
  }
  return examples.filter((example) => Number.isFinite(example.plannedTimestamp))
    .sort((a, b) => a.plannedTimestamp - b.plannedTimestamp);
};

const featureNames = [
  'intercept', 'currentDelayMinutes', 'leadMinutes', 'hourSin', 'hourCos',
  'weekdaySin', 'weekdayCos', 'trafficJam', 'directionH',
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
    ...LINES.map((line) => example.line === line ? 1 : 0),
  ];
};

const standardisedIndices = new Set([1, 2]);

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

const fitRidge = (examples, scaling, lambda = 2) => {
  const size = featureNames.length;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  const values = Array(size).fill(0);
  for (const example of examples) {
    const vector = vectorise(example, scaling);
    for (let row = 0; row < size; row += 1) {
      values[row] += vector[row] * example.targetDelayMinutes;
      for (let column = 0; column < size; column += 1) {
        matrix[row][column] += vector[row] * vector[column];
      }
    }
  }
  for (let index = 1; index < size; index += 1) matrix[index][index] += lambda;
  return solveLinearSystem(matrix, values);
};

const predict = (example, scaling, weights) => clamp(
  vectorise(example, scaling).reduce((sum, value, index) => sum + value * weights[index], 0),
  -2,
  30,
);

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

const rows = await readRows();
const examples = makeExamples(rows);
const uniqueDates = [...new Set(rows.map((row) => new Date(row.observedAt).toISOString().slice(0, 10)))].sort();
const firstObservationMs = rows.reduce((earliest, row) => Math.min(earliest, row.observedAt), Infinity);
const lastObservationMs = rows.reduce((latest, row) => Math.max(latest, row.observedAt), -Infinity);
const firstObservation = Number.isFinite(firstObservationMs) ? new Date(firstObservationMs).toISOString() : null;
const lastObservation = Number.isFinite(lastObservationMs) ? new Date(lastObservationMs).toISOString() : null;
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

const common = {
  schemaVersion: 1,
  target: 'Final Wiener Linien reported delay, in minutes, near departure',
  observationCount: rows.length,
  labelledJourneyCount: examples.length,
  dataDays: uniqueDates.length,
  firstObservation,
  lastObservation,
  requirements: { minimumDays: MIN_DAYS, minimumExamples: MIN_EXAMPLES, minimumTestExamples: MIN_TEST_EXAMPLES },
};

let model;
let metrics;
if (uniqueDates.length < MIN_DAYS || examples.length < MIN_EXAMPLES || candidateTest.length < MIN_TEST_EXAMPLES) {
  model = { ...common, status: 'collecting', trainedAt: null };
  metrics = {
    ...common,
    status: 'collecting',
    message: `Collecting at least ${MIN_DAYS} days and ${MIN_EXAMPLES} labelled journeys before publishing a score.`,
    leakageControl: 'One early observation per journey; later near-departure observation becomes its label.',
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
  const deployed = modelMetrics.maeMinutes < baselineMetrics.maeMinutes;
  const trainedAt = new Date().toISOString();
  const cutoff = new Date(test[0].plannedTimestamp).toISOString();
  model = {
    ...common,
    status: 'ready',
    algorithm: 'ridge-regression',
    trainedAt,
    deployed,
    trainedThrough: new Date(training.at(-1).plannedTimestamp).toISOString(),
    featureNames,
    scaling: scaling.map(({ mean, scale }) => ({ mean: round(mean, 8), scale: round(scale, 8) })),
    weights: weights.map((weight) => round(weight, 8)),
    predictionRangeMinutes: [-2, 30],
  };
  metrics = {
    ...common,
    status: 'ready',
    trainedAt,
    algorithm: 'Ridge regression',
    split: {
      method: 'Chronological split by whole calendar days; the newest 20% of days are test-only',
      trainingExamples: training.length,
      testExamples: test.length,
      testPeriodStarts: cutoff,
    },
    model: modelMetrics,
    currentEstimateBaseline: baselineMetrics,
    deployment: {
      deployed,
      rule: 'Publish live predictions only when test MAE beats carrying forward the early operator estimate.',
    },
    delayClassificationThresholdMinutes: DELAY_THRESHOLD_MINUTES,
    labelCaveat: 'The target is Wiener Linien timeReal minus timePlanned near departure, not an independent GPS ground truth.',
  };
}

await mkdir(dirname(MODEL_PATH), { recursive: true });
await mkdir(dirname(METRICS_PATH), { recursive: true });
await writeFile(MODEL_PATH, `${JSON.stringify(model, null, 2)}\n`);
await writeFile(METRICS_PATH, `${JSON.stringify(metrics, null, 2)}\n`);
console.log(JSON.stringify(metrics, null, 2));

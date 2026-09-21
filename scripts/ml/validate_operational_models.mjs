#!/usr/bin/env node

/*
 * Honest, chronological validation for the operational-model registry.
 *
 * This deliberately does not label heuristics as trained. It uses the newest
 * calendar day(s) as an untouched holdout and reports which models have a real
 * target today, which have only descriptive event coverage, and which still
 * need an external label such as passenger counts.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const OBSERVATION_DIR = resolve(ROOT, process.env.DELAY_OBSERVATIONS_DIR || 'data/ml/observations');
const HEADWAY_DIR = resolve(ROOT, process.env.HEADWAY_EVENTS_DIR || 'data/ml/headway-events');
const OPERATIONAL_MODELS_PATH = resolve(ROOT, process.env.OPERATIONAL_MODELS_PATH || 'data/ml/operational-models.json');
const OUTPUT_PATH = resolve(ROOT, process.env.OPERATIONAL_VALIDATION_PATH || 'data/ml/operational-validation.json');

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, digits = 3) => Number(Number(value).toFixed(digits));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const quantile = (values, probability) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (index - low);
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

const targetDelay = (row) => finite(row.officialDelaySeconds ?? row.reportedDelaySeconds);
const rowDay = (row) => Number.isFinite(Number(row.observedAt))
  ? new Date(Number(row.observedAt)).toISOString().slice(0, 10) : null;
const lineOf = (row) => String(row.line || 'unknown');

const rows = await readJsonlDir(OBSERVATION_DIR);
const headwayEvents = await readJsonlDir(HEADWAY_DIR);
const labelled = rows.filter((row) => targetDelay(row) !== null && rowDay(row));
const days = [...new Set(labelled.map(rowDay))].sort();
// Keep at least one full day unseen. With a short archive this is still more
// useful than a random split because it tests forward-time generalisation.
const holdoutDayCount = days.length > 2 ? Math.max(1, Math.ceil(days.length * 0.2)) : days.length === 2 ? 1 : 0;
const holdoutDays = new Set(holdoutDayCount ? days.slice(-holdoutDayCount) : []);
const trainRows = labelled.filter((row) => !holdoutDays.has(rowDay(row)));
const holdoutRows = labelled.filter((row) => holdoutDays.has(rowDay(row)));

const globalTrainingDelays = trainRows.map(targetDelay).map((value) => value / 60);
const trainingByLine = new Map();
for (const row of trainRows) {
  const list = trainingByLine.get(lineOf(row)) || [];
  list.push(targetDelay(row) / 60);
  trainingByLine.set(lineOf(row), list);
}
const predictionFor = (row) => median(trainingByLine.get(lineOf(row)) || []) ?? median(globalTrainingDelays) ?? 0;
const errors = holdoutRows.map((row) => (predictionFor(row) - targetDelay(row) / 60));
const mae = errors.length ? mean(errors.map((error) => Math.abs(error))) : null;
const rmse = errors.length ? Math.sqrt(mean(errors.map((error) => error ** 2))) : null;

const category = (minutes) => minutes >= 5 ? 'severe' : minutes >= 3 ? 'major' : minutes >= 1 ? 'minor' : 'on-time';
const labels = holdoutRows.map((row) => category(targetDelay(row) / 60));
const predictions = holdoutRows.map((row) => category(predictionFor(row)));
const accuracy = labels.length ? predictions.filter((value, index) => value === labels[index]).length / labels.length : null;
const classes = ['on-time', 'minor', 'major', 'severe'];
const f1ByClass = classes.map((name) => {
  const tp = labels.filter((value, index) => value === name && predictions[index] === name).length;
  const fp = labels.filter((value, index) => value !== name && predictions[index] === name).length;
  const fn = labels.filter((value, index) => value === name && predictions[index] !== name).length;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
});
const macroF1 = labels.length ? mean(f1ByClass) : null;

const bandRows = holdoutRows.map((row) => {
  const values = trainingByLine.get(lineOf(row)) || globalTrainingDelays;
  const low = quantile(values, 0.1);
  const high = quantile(values, 0.9);
  const actual = targetDelay(row) / 60;
  return { covered: low !== null && high !== null && actual >= low && actual <= high, width: high - low };
});
const onTimeRate = (subset) => subset.length
  ? subset.filter((row) => targetDelay(row) < 60).length / subset.length : null;
const lineReliability = [...new Set(holdoutRows.map(lineOf))].sort().map((line) => {
  const train = trainRows.filter((row) => lineOf(row) === line);
  const holdout = holdoutRows.filter((row) => lineOf(row) === line);
  return { line, trainingOnTimeRate: train.length ? round(onTimeRate(train), 3) : null, holdoutOnTimeRate: round(onTimeRate(holdout), 3), samples: holdout.length };
});

const eventDays = [...new Set(headwayEvents.map((event) => Number.isFinite(Number(event.observedAt))
  ? new Date(Number(event.observedAt)).toISOString().slice(0, 10) : null).filter(Boolean))].sort();
const eventHoldoutDayCount = eventDays.length ? Math.max(1, Math.ceil(eventDays.length * 0.2)) : 0;
const eventHoldoutDays = new Set(eventHoldoutDayCount ? eventDays.slice(-eventHoldoutDayCount) : []);
const eventHoldout = headwayEvents.filter((event) => eventHoldoutDays.has(new Date(Number(event.observedAt)).toISOString().slice(0, 10)));
const recoveryHoldout = eventHoldout.filter((event) => event.eventStatus === 'recovered' && finite(event.recoveryDurationSeconds) !== null);

const validation = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  methodology: 'chronological holdout by calendar day; newest day(s) are never used to fit the reported baseline',
  split: {
    trainingDays: days.filter((day) => !holdoutDays.has(day)),
    holdoutDays: [...holdoutDays],
    trainingRows: trainRows.length,
    holdoutRows: holdoutRows.length,
  },
  models: {
    'multi-horizon-delay': {
      status: errors.length && trainRows.length ? 'validated-baseline' : 'insufficient-holdout',
      samples: errors.length,
      maeMinutes: mae === null ? null : round(mae),
      rmseMinutes: rmse === null ? null : round(rmse),
      note: 'Uses a per-line historical median; the deployed ridge model remains the production delay model.',
    },
    'delay-severity': {
      status: labels.length && trainRows.length ? 'validated-baseline' : 'insufficient-holdout',
      samples: labels.length,
      accuracyPercent: accuracy === null ? null : round(accuracy * 100, 1),
      macroF1: macroF1 === null ? null : round(macroF1),
    },
    'delay-bands': {
      status: bandRows.length && trainRows.length ? 'validated-baseline' : 'insufficient-holdout',
      samples: bandRows.length,
      p10ToP90CoveragePercent: bandRows.length ? round(bandRows.filter((row) => row.covered).length / bandRows.length * 100, 1) : null,
      meanIntervalWidthMinutes: bandRows.length ? round(mean(bandRows.map((row) => row.width)), 2) : null,
    },
    'route-reliability': {
      status: lineReliability.length ? 'validated-descriptive' : 'insufficient-holdout',
      samples: holdoutRows.length,
      lines: lineReliability,
    },
    'headway-bunching': {
      status: eventHoldout.length ? 'validated-descriptive' : 'insufficient-holdout',
      eventSamples: eventHoldout.length,
      gapEvents: eventHoldout.filter((event) => event.type === 'gap').length,
      bunchEvents: eventHoldout.filter((event) => event.type === 'bunch').length,
      note: 'Event lifecycle coverage is reported; a precision/recall score needs a complete no-event label stream.',
    },
    'recovery-duration': {
      status: recoveryHoldout.length ? 'validated-descriptive' : 'insufficient-holdout',
      recoveredEventSamples: recoveryHoldout.length,
      medianRecoveryMinutes: recoveryHoldout.length ? round(median(recoveryHoldout.map((event) => Number(event.recoveryDurationSeconds) / 60)), 2) : null,
    },
  },
};

let report;
try { report = JSON.parse(await readFile(OPERATIONAL_MODELS_PATH, 'utf8')); } catch { report = null; }
if (report) {
  report.validation = validation;
  await writeFile(OPERATIONAL_MODELS_PATH, `${JSON.stringify(report, null, 2)}\n`);
}
await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(validation, null, 2)}\n`);
console.log(JSON.stringify({ holdoutRows: holdoutRows.length, holdoutDays: [...holdoutDays], delayMaeMinutes: validation.models['multi-horizon-delay'].maeMinutes }));

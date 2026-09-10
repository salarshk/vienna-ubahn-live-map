const GLOBAL_PRIOR = 24;
const LINE_PRIOR = 12;
const CONTEXT_PRIOR = 10;

const emptyStat = () => ({ count: 0, sum: 0, sumSquares: 0 });
const meanWithPrior = (stat, prior) => stat?.count ? stat.sum / (stat.count + prior) : 0;
const contextKey = (example) => {
  if (example.delayRelatedIncident || Number(example.activeIncidentCount) > 0) return 'incident';
  if (example.trafficJam) return 'traffic';
  return 'normal';
};

export const emptyOnlineState = () => ({
  global: emptyStat(),
  lines: {},
  contexts: {},
});

export const onlineCorrections = (state, example) => {
  const global = meanWithPrior(state?.global, GLOBAL_PRIOR);
  const line = meanWithPrior(state?.lines?.[example.line], LINE_PRIOR);
  const context = meanWithPrior(state?.contexts?.[contextKey(example)], CONTEXT_PRIOR);
  return { global, line, context, total: global + line + context };
};

const updateStat = (stat, value) => {
  stat.count += 1;
  stat.sum += value;
  stat.sumSquares += value ** 2;
};

const settlePrediction = (state, pending) => {
  const baseError = pending.example.targetDelayMinutes - pending.example.currentDelayMinutes;
  updateStat(state.global, baseError);
  const lineStat = state.lines[pending.example.line] ||= emptyStat();
  updateStat(lineStat, baseError - pending.corrections.global);
  const key = contextKey(pending.example);
  const contextStat = state.contexts[key] ||= emptyStat();
  updateStat(contextStat, baseError - pending.corrections.global - pending.corrections.line);
};

export const replayOnlineCalibration = (examples, { minimumExamples = 30 } = {}) => {
  const state = emptyOnlineState();
  const predictions = [];
  const actual = [];
  const baseline = [];
  const pending = [];
  const ordered = [...examples].sort((a, b) => (
    a.featureObservedAt - b.featureObservedAt || a.eventKey.localeCompare(b.eventKey)
  ));

  const settleAvailable = (atMs) => {
    pending.sort((a, b) => a.example.labelObservedAt - b.example.labelObservedAt);
    while (pending.length && pending[0].example.labelObservedAt <= atMs) {
      settlePrediction(state, pending.shift());
    }
  };

  for (const example of ordered) {
    settleAvailable(example.featureObservedAt);
    const corrections = onlineCorrections(state, example);
    predictions.push(example.currentDelayMinutes + corrections.total);
    actual.push(example.targetDelayMinutes);
    baseline.push(example.currentDelayMinutes);
    pending.push({ example, corrections });
  }
  settleAvailable(Infinity);

  return {
    status: examples.length >= minimumExamples ? 'ready' : 'collecting',
    minimumExamples,
    scoredJourneyCount: examples.length,
    state,
    actual,
    predictions,
    baseline,
  };
};


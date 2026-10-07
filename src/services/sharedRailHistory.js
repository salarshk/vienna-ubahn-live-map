import { STATION_DELAY_WINDOWS } from './officialSnapshotStore';

const DEFAULT_URL = 'https://vienna-rail-advisor.vienna-u-bahn-live-map.workers.dev/rail-history';
export const RAIL_HISTORY_URL = String(import.meta.env.VITE_RAIL_HISTORY_API_URL || (import.meta.env.PROD ? DEFAULT_URL : '')).trim();
const CACHE_MS = 60 * 1000;
const cache = new Map();

export const railHistoryUrl = (params = {}) => {
  if (!RAIL_HISTORY_URL) return null;
  const url = new URL(RAIL_HISTORY_URL);
  Object.entries(params).forEach(([key, value]) => { if (value != null && value !== '') url.searchParams.set(key, String(value)); });
  return url.toString();
};

export const fetchRailHistory = async (params = {}) => {
  const url = railHistoryUrl(params);
  if (!url) return { status: 'not configured', recent: [], hourly: [] };
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Shared history HTTP ${response.status}`);
  const data = await response.json();
  cache.set(url, { at: Date.now(), data });
  return data;
};

const normalise = (value) => String(value || '').trim().toLocaleLowerCase('de-AT');
const add = (target, row) => {
  for (const key of ['observations', 'labelledObservations', 'delaySumSeconds', 'etaPairs', 'etaStablePairs', 'etaRevisionSumSeconds', 'delayedThreeMinutes']) {
    target[key] = (target[key] || 0) + (Number(row[key]) || 0);
  }
  target.maxEtaRevisionSeconds = Math.max(target.maxEtaRevisionSeconds || 0, Number(row.maxEtaRevisionSeconds) || 0);
  if (row.maxDelaySeconds != null) target.maxDelaySeconds = target.maxDelaySeconds == null ? Number(row.maxDelaySeconds) : Math.max(target.maxDelaySeconds, Number(row.maxDelaySeconds));
};

export const stationDelayWindowsFromHistory = (history, stationName, stationLines = [], now = Date.now()) => {
  const known = new Set(stationLines.map(String));
  const samples = (history?.recent || []).map((sample) => ({
    at: Number(sample.at),
    rows: sample.rows.filter((row) => normalise(row.stationName) === normalise(stationName) && (!known.size || known.has(row.line))),
  }));
  samples.forEach(({ rows }) => rows.forEach((row) => known.add(row.line)));
  return STATION_DELAY_WINDOWS.map((window) => {
    const totals = new Map([...known].map((line) => [line, { line, observations: 0, labelledObservations: 0, delaySumSeconds: 0, etaPairs: 0, etaStablePairs: 0, etaRevisionSumSeconds: 0, delayedThreeMinutes: 0, maxDelaySeconds: null, maxEtaRevisionSeconds: 0 }]));
    for (const sample of samples) {
      if (sample.at < now - window.durationMs || sample.at > now) continue;
      for (const row of sample.rows) {
        const target = totals.get(row.line) || { line: row.line, observations: 0, labelledObservations: 0, delaySumSeconds: 0 };
        add(target, row);
        totals.set(row.line, target);
      }
    }
    return { ...window, lines: [...totals.values()].sort((a, b) => a.line.localeCompare(b.line)).map((row) => ({
      ...row, meanDelaySeconds: row.labelledObservations ? Math.round(row.delaySumSeconds / row.labelledObservations) : null,
      stableEtaPercent: row.etaPairs ? Math.round(100 * row.etaStablePairs / row.etaPairs) : null,
      meanEtaRevisionSeconds: row.etaPairs ? Math.round(row.etaRevisionSumSeconds / row.etaPairs) : null,
    })) };
  });
};

export const buildDelayOnsets = (history, now = Date.now()) => {
  const groups = new Map();
  for (const sample of history?.recent || []) {
    if (sample.at < now - 60 * 60000 || sample.at > now) continue;
    for (const row of sample.rows) {
      const key = `${row.stationName}|${row.line}|${row.direction || ''}`;
      const current = groups.get(key) || { stationName: row.stationName, line: row.line, direction: row.direction, earlier: { labelledObservations: 0, delaySumSeconds: 0 }, recent: { labelledObservations: 0, delaySumSeconds: 0 } };
      add(sample.at >= now - 30 * 60000 ? current.recent : current.earlier, row);
      groups.set(key, current);
    }
  }
  return [...groups.values()].map((row) => ({
    ...row,
    riseSeconds: row.earlier.labelledObservations >= 3 && row.recent.labelledObservations >= 3
      ? Math.round(row.recent.delaySumSeconds / row.recent.labelledObservations - row.earlier.delaySumSeconds / row.earlier.labelledObservations)
      : null,
  })).filter((row) => row.riseSeconds >= 60).sort((a, b) => b.riseSeconds - a.riseSeconds).slice(0, 8);
};

export const buildReliabilityRanking = (history) => {
  const groups = new Map();
  for (const row of history?.hourly || []) {
    const key = `${row.stationName}|${row.line}|${row.direction || ''}`;
    const target = groups.get(key) || { stationName: row.stationName, line: row.line, direction: row.direction, observations: 0, labelledObservations: 0, delaySumSeconds: 0, delayedThreeMinutes: 0, etaPairs: 0, etaStablePairs: 0, etaRevisionSumSeconds: 0, maxEtaRevisionSeconds: 0 };
    add(target, row);
    groups.set(key, target);
  }
  return [...groups.values()].filter((row) => row.labelledObservations >= 3).map((row) => ({
    ...row,
    meanDelaySeconds: Math.round(row.delaySumSeconds / row.labelledObservations),
    lateThreePercent: Math.round(100 * row.delayedThreeMinutes / row.labelledObservations),
    stableEtaPercent: row.etaPairs ? Math.round(100 * row.etaStablePairs / row.etaPairs) : null,
  })).sort((a, b) => b.meanDelaySeconds - a.meanDelaySeconds);
};

export const estimatedArrivalByChance = ({ departureAt, travelSeconds, deadlineAt, etaPairs = 0, meanEtaRevisionSeconds = null }) => {
  if (![departureAt, travelSeconds, deadlineAt].every(Number.isFinite)) return null;
  const expectedAt = departureAt + travelSeconds * 1000;
  const uncertaintySeconds = Math.max(120, Number(meanEtaRevisionSeconds) * 2 || 0);
  // A probability is withheld until enough observed ETA revisions exist. The
  // interval remains useful, but is not an externally validated calibration.
  const chance = etaPairs >= 30 ? Math.round(100 / (1 + Math.exp(-(deadlineAt - expectedAt) / (uncertaintySeconds * 1000 / 1.7)))) : null;
  return { expectedAt, lowerAt: expectedAt - uncertaintySeconds * 1000, upperAt: expectedAt + uncertaintySeconds * 1000, chance, evidencePairs: etaPairs, uncertaintySeconds };
};

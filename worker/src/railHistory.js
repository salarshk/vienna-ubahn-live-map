// Shared, bounded history of official departure predictions. This is not a
// physical train-position or actual-arrival archive.
const LATEST_KEY = 'rail-history/latest.json';
const DAY_PREFIX = 'rail-history/days/';
const RECENT_MS = 4 * 60 * 60 * 1000;
const MAX_DAYS = 14;
const PUBLIC_LINES = new Set(['U1', 'U2', 'U3', 'U4', 'U6', '1', '2', 'D', 'O']);

const readObject = async (bucket, key) => {
  const object = await bucket.get(key);
  if (!object) return null;
  try { return await object.json(); } catch { return null; }
};

const writeObject = (bucket, key, value) => bucket.put(key, JSON.stringify(value), {
  httpMetadata: { contentType: 'application/json' },
});

const stationKey = (item) => `${item.stationId || item.stationName}|${item.line}|${item.destination || item.direction || ''}`;
const departureKey = (item) => `${stationKey(item)}|${item.plannedTimestamp}|${item.vehicleId || ''}`;
const rowKey = (item, hour) => `${hour}|${stationKey(item)}`;

const emptyRow = (item, hour = null) => ({
  ...(hour == null ? {} : { hour }),
  stationId: item.stationId || null,
  stationName: item.stationName,
  line: item.line,
  direction: item.destination || item.direction || null,
  observations: 0,
  labelledObservations: 0,
  delaySumSeconds: 0,
  delayedThreeMinutes: 0,
  maxDelaySeconds: null,
  etaPairs: 0,
  etaStablePairs: 0,
  etaRevisionSumSeconds: 0,
  maxEtaRevisionSeconds: 0,
});

const addRow = (target, source) => {
  for (const key of ['observations', 'labelledObservations', 'delaySumSeconds', 'delayedThreeMinutes', 'etaPairs', 'etaStablePairs', 'etaRevisionSumSeconds']) {
    target[key] += Number(source[key]) || 0;
  }
  if (source.maxDelaySeconds != null) target.maxDelaySeconds = target.maxDelaySeconds == null
    ? source.maxDelaySeconds : Math.max(target.maxDelaySeconds, source.maxDelaySeconds);
  target.maxEtaRevisionSeconds = Math.max(target.maxEtaRevisionSeconds, Number(source.maxEtaRevisionSeconds) || 0);
};

export const summariseRailSample = (snapshot, previous = {}) => {
  const groups = new Map();
  const nextDepartures = {};
  const at = Number(snapshot.generatedAt) || Date.now();
  for (const item of snapshot.observations || []) {
    if (!item.stationName || !item.line || !Number.isFinite(item.plannedTimestamp)) continue;
    const key = stationKey(item);
    const row = groups.get(key) || emptyRow(item);
    row.observations += 1;
    if (Number.isFinite(item.reportedDelaySeconds)) {
      row.labelledObservations += 1;
      row.delaySumSeconds += item.reportedDelaySeconds;
      row.delayedThreeMinutes += item.reportedDelaySeconds >= 180 ? 1 : 0;
      row.maxDelaySeconds = Math.max(row.maxDelaySeconds ?? -Infinity, item.reportedDelaySeconds);
    }
    const departure = departureKey(item);
    const prior = previous[departure];
    if (Number.isFinite(prior) && Number.isFinite(item.realtimeTimestamp)) {
      const revision = Math.abs(Math.round((item.realtimeTimestamp - prior) / 1000));
      row.etaPairs += 1;
      row.etaStablePairs += revision <= 60 ? 1 : 0;
      row.etaRevisionSumSeconds += revision;
      row.maxEtaRevisionSeconds = Math.max(row.maxEtaRevisionSeconds, revision);
    }
    if (item.realtimeTimestamp > at - 60000 && item.realtimeTimestamp < at + 45 * 60000) {
      nextDepartures[departure] = item.realtimeTimestamp;
    }
    groups.set(key, row);
  }
  return { sample: { at, sourceServerTime: snapshot.sourceServerTime || null, rows: [...groups.values()] }, nextDepartures };
};

export const updateRailHistory = async (env, snapshot) => {
  const bucket = env?.RAIL_ARCHIVE;
  if (!bucket?.get || !bucket?.put) return null;
  const at = Number(snapshot.generatedAt) || Date.now();
  const date = new Date(at).toISOString().slice(0, 10);
  const [latest, day] = await Promise.all([
    readObject(bucket, LATEST_KEY),
    readObject(bucket, `${DAY_PREFIX}${date}.json`),
  ]);
  const minute = Math.floor(at / 60000);
  if (latest?.minute === minute || (snapshot.sourceServerTime && latest?.sourceServerTime === snapshot.sourceServerTime)) return latest;
  const { sample, nextDepartures } = summariseRailSample(snapshot, latest?.previousDepartures || {});
  const samples = [...(latest?.samples || []), sample].filter((item) => item.at >= at - RECENT_MS);
  const hour = new Date(at).toISOString().slice(0, 13) + ':00:00Z';
  const hourly = new Map((day?.hourly || []).map((row) => [rowKey(row, row.hour), row]));
  for (const row of sample.rows) {
    const key = rowKey(row, hour);
    const target = hourly.get(key) || emptyRow(row, hour);
    addRow(target, row);
    hourly.set(key, target);
  }
  const nextLatest = {
    version: 1, updatedAt: at, minute, sourceServerTime: sample.sourceServerTime,
    sampleCadenceSeconds: samples.length > 1
      ? Math.round((samples.at(-1).at - samples.at(-2).at) / 1000) : null,
    coverage: snapshot.completeness || null,
    samples, previousDepartures: nextDepartures,
  };
  const dailyRows = [...hourly.values()];
  const lineExports = new Date(at).getUTCMinutes() % 5 === 0
    ? [...PUBLIC_LINES].map((line) => writeObject(bucket, `rail-history/lines/${date}/${line}.json`, {
      date, line, hourly: dailyRows.filter((row) => row.line === line),
    })) : [];
  await Promise.all([
    writeObject(bucket, LATEST_KEY, nextLatest),
    writeObject(bucket, `${DAY_PREFIX}${date}.json`, { date, hourly: dailyRows }),
    ...lineExports,
  ]);
  return nextLatest;
};

const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const csvFor = (rows) => {
  const fields = ['hour', 'stationId', 'stationName', 'line', 'direction', 'observations', 'labelledObservations', 'delaySumSeconds', 'delayedThreeMinutes', 'maxDelaySeconds', 'etaPairs', 'etaStablePairs', 'etaRevisionSumSeconds', 'maxEtaRevisionSeconds'];
  return [fields.join(','), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(','))].join('\n');
};

export const handleRailHistory = async (request, env, origin) => {
  const headers = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Cache-Control': 'public, max-age=0, s-maxage=60' };
  if (!env?.RAIL_ARCHIVE?.get) return new Response(JSON.stringify({ status: 'not configured', message: 'Shared R2 history is not connected.' }), { status: 503, headers: { ...headers, 'Content-Type': 'application/json' } });
  const url = new URL(request.url);
  const line = String(url.searchParams.get('line') || '').trim().toUpperCase();
  const requestedDays = Number.parseInt(url.searchParams.get('days') ?? '7', 10);
  const days = Number.isFinite(requestedDays) ? Math.max(0, Math.min(MAX_DAYS, requestedDays)) : 7;
  if (days > 1 && !PUBLIC_LINES.has(line)) return new Response(JSON.stringify({ error: 'Select a supported line for multi-day history.' }), { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } });
  const now = Date.now();
  const keys = Array.from({ length: days }, (_, index) => {
    const date = new Date(now - index * 86400000).toISOString().slice(0, 10);
    return line && PUBLIC_LINES.has(line) ? `rail-history/lines/${date}/${line}.json` : `${DAY_PREFIX}${date}.json`;
  });
  const [latest, ...archives] = await Promise.all([
    readObject(env.RAIL_ARCHIVE, LATEST_KEY),
    ...keys.map((key) => readObject(env.RAIL_ARCHIVE, key)),
  ]);
  const station = String(url.searchParams.get('station') || '').trim().toLocaleLowerCase('de-AT');
  const direction = String(url.searchParams.get('direction') || '').trim().toLocaleLowerCase('de-AT');
  const match = (row) => (!station || String(row.stationId) === station || String(row.stationName || '').toLocaleLowerCase('de-AT') === station)
    && (!line || row.line === line)
    && (!direction || String(row.direction || '').toLocaleLowerCase('de-AT') === direction);
  const hourly = archives.flatMap((archive) => archive?.hourly || []).filter(match).sort((a, b) => a.hour.localeCompare(b.hour));
  if (url.searchParams.get('format') === 'csv') return new Response(csvFor(hourly), {
    headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="vienna-rail-reliability.csv"' },
  });
  const recent = (latest?.samples || []).map((sample) => ({ at: sample.at, rows: sample.rows.filter(match) })).filter((sample) => sample.rows.length);
  return new Response(JSON.stringify({
    status: latest ? 'ready' : 'collecting', generatedAt: latest?.updatedAt || null,
    source: 'official-wiener-linien-departure-predictions', sampleCadenceSeconds: latest?.sampleCadenceSeconds || null,
    caveat: 'Prediction revisions and reported delays are not independently observed train-arrival times or GPS.',
    coverage: latest?.coverage || null, recent, hourly, daysRequested: days,
  }), { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
};

// Shared, bounded history of official departure predictions. This is not a
// physical train-position or actual-arrival archive.
const LATEST_KEY = 'rail-history/v2/latest.json';
const LEGACY_LATEST_KEY = 'rail-history/latest.json';
const SAMPLE_PREFIX = 'rail-history/v2/samples/';
const BLOCK_PREFIX = 'rail-history/v2/blocks/';
const DAY_PREFIX = 'rail-history/days/';
const RECENT_MS = 4 * 60 * 60 * 1000;
const MAX_DAYS = 14;
const PUBLIC_LINES = new Set(['U1', 'U2', 'U3', 'U4', 'U6', '1', '2', 'D', 'O']);
const HISTORY_STALE_MS = 10 * 60 * 1000;

const minuteKey = (at) => {
  const iso = new Date(at).toISOString();
  return `${SAMPLE_PREFIX}${iso.slice(0, 10)}/${iso.slice(11, 16).replace(':', '-')}.json`;
};

const blockKey = (at) => {
  const iso = new Date(at).toISOString();
  const halfHour = Number(iso.slice(14, 16)) < 30 ? '00' : '30';
  return `${BLOCK_PREFIX}${iso.slice(0, 10)}/${iso.slice(11, 13)}-${halfHour}.json`;
};

// A 30-minute R2 block, rather than a four-hour object, is rewritten each
// minute. The dated minute samples are append-only and do not expire in code.
const packRow = (row) => [row.stationId, row.stationName, row.line, row.direction,
  row.observations, row.labelledObservations, row.delaySumSeconds,
  row.delayedThreeMinutes, row.maxDelaySeconds, row.etaPairs,
  row.etaStablePairs, row.etaRevisionSumSeconds, row.maxEtaRevisionSeconds];
const unpackRow = (row) => Array.isArray(row) ? {
  stationId: row[0], stationName: row[1], line: row[2], direction: row[3],
  observations: row[4], labelledObservations: row[5], delaySumSeconds: row[6],
  delayedThreeMinutes: row[7], maxDelaySeconds: row[8], etaPairs: row[9],
  etaStablePairs: row[10], etaRevisionSumSeconds: row[11], maxEtaRevisionSeconds: row[12],
} : row;

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
  const latest = await readObject(bucket, LATEST_KEY);
  const minute = Math.floor(at / 60000);
  if ((latest?.updatedAt && at <= latest.updatedAt)
    || latest?.minute === minute
    || (snapshot.sourceServerTime && latest?.sourceServerTime === snapshot.sourceServerTime)) return latest;
  const { sample, nextDepartures } = summariseRailSample(snapshot, latest?.previousDepartures || {});
  const packedSample = { at: sample.at, sourceServerTime: sample.sourceServerTime, rows: sample.rows.map(packRow) };
  const key = blockKey(at);
  const block = await readObject(bucket, key);
  const samples = [...(block?.samples || []).filter((item) => Math.floor(item.at / 60000) !== minute), packedSample]
    .sort((a, b) => a.at - b.at);
  const nextLatest = {
    version: 2, startedAt: latest?.startedAt || at, updatedAt: at, minute,
    sourceServerTime: sample.sourceServerTime,
    sampleCadenceSeconds: latest?.updatedAt ? Math.round((at - latest.updatedAt) / 1000) : null,
    coverage: snapshot.completeness || null,
    previousDepartures: nextDepartures,
  };
  await Promise.all([
    writeObject(bucket, key, { version: 2, samples }),
    writeObject(bucket, minuteKey(at), packedSample),
  ]);
  // Commit the cursor only after both durable records succeeded. A cron retry
  // can then safely fill a partial write without double-counting the minute.
  await writeObject(bucket, LATEST_KEY, nextLatest);
  return nextLatest;
};

// Runs in a separate cron invocation so a growing multi-day public report can
// never starve the minute-by-minute collector or the bike archive.
export const publishRailHistory = async (env, at = Date.now()) => {
  const bucket = env?.RAIL_ARCHIVE;
  if (!bucket?.get || !bucket?.put) return null;
  const currentMinute = Math.floor(at / 60000);
  // Up to 25 reads plus two day objects and their line exports stays below
  // the Workers Free 50-subrequest limit, including a midnight crossover.
  const keys = Array.from({ length: 25 }, (_, index) => minuteKey((currentMinute - index) * 60000));
  const samples = (await Promise.all(keys.map((key) => readObject(bucket, key))))
    .filter(Boolean).sort((a, b) => a.at - b.at);
  const byDate = new Map();
  for (const sample of samples) {
    const date = new Date(sample.at).toISOString().slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(sample);
  }
  const published = [];
  for (const [date, datedSamples] of byDate) {
    const day = await readObject(bucket, `${DAY_PREFIX}${date}.json`);
    const hourly = new Map((day?.hourly || []).map((row) => [rowKey(row, row.hour), row]));
    const pending = datedSamples.filter((sample) => sample.at > (day?.v2ProcessedThrough || 0));
    if (!pending.length) continue;
    for (const sample of pending) {
      const hour = new Date(sample.at).toISOString().slice(0, 13) + ':00:00Z';
      for (const packed of sample.rows || []) {
        const row = unpackRow(packed);
        const key = rowKey(row, hour);
        const target = hourly.get(key) || emptyRow(row, hour);
        addRow(target, row);
        hourly.set(key, target);
      }
    }
    const dailyRows = [...hourly.values()];
    await Promise.all([...PUBLIC_LINES].map((line) => writeObject(bucket, `rail-history/lines/${date}/${line}.json`, {
        date, line, hourly: dailyRows.filter((row) => row.line === line),
      })));
    // Advance the publication cursor only after every line export exists.
    await writeObject(bucket, `${DAY_PREFIX}${date}.json`, {
      date, hourly: dailyRows, v2ProcessedThrough: pending.at(-1).at,
    });
    published.push({ date, samples: pending.length, rows: dailyRows.length });
  }
  return published;
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
  const [newLatest, legacyLatest] = await Promise.all([
    readObject(env.RAIL_ARCHIVE, LATEST_KEY),
    readObject(env.RAIL_ARCHIVE, LEGACY_LATEST_KEY),
  ]);
  const latest = newLatest || legacyLatest;
  const blockKeys = latest?.version === 2
    ? [...new Set(Array.from({ length: 9 }, (_, index) => blockKey(now - index * 30 * 60000)))]
    : [];
  const [archives, blocks] = await Promise.all([
    Promise.all(keys.map((key) => readObject(env.RAIL_ARCHIVE, key))),
    Promise.all(blockKeys.map((key) => readObject(env.RAIL_ARCHIVE, key))),
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
  const newRecent = blocks.flatMap((block) => block?.samples || []);
  const firstNewAt = newRecent.reduce((earliest, sample) => Math.min(earliest, sample.at), Infinity);
  const allRecent = latest?.version === 2
    ? [...(legacyLatest?.samples || []).filter((sample) => sample.at < firstNewAt), ...newRecent]
    : latest?.samples || [];
  const recent = allRecent.filter((sample) => sample.at >= now - RECENT_MS && sample.at <= now + 60000)
    .map((sample) => ({
      at: sample.at,
      rows: (sample.rows || []).filter((row) => match(Array.isArray(row) ? {
        stationId: row[0], stationName: row[1], line: row[2], direction: row[3],
      } : row)).map(unpackRow),
    })).filter((sample) => sample.rows.length).sort((a, b) => a.at - b.at);
  const archiveAgeSeconds = latest ? Math.max(0, Math.round((now - latest.updatedAt) / 1000)) : null;
  return new Response(JSON.stringify({
    status: !latest ? 'collecting' : archiveAgeSeconds > HISTORY_STALE_MS / 1000 ? 'stale' : 'ready',
    generatedAt: latest?.updatedAt || null, archiveAgeSeconds,
    source: 'official-wiener-linien-departure-predictions', sampleCadenceSeconds: latest?.sampleCadenceSeconds || null,
    caveat: 'Prediction revisions and reported delays are not independently observed train-arrival times or GPS.',
    coverage: latest?.coverage || null, recent, hourly, daysRequested: days,
  }), { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
};

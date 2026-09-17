const LINES = ['U1', 'U2', 'U3', 'U4', 'U6'];
const MONITOR_STATIONS = [
  60201320, 60201182, 60201468, 60200657, 60201040, 60200299,
  60201430, 60200743, 60201198, 60201062, 60201015, 60201510,
];

const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, Number(value) || 0));
const round = (value, digits = 1) => Number((Number(value) || 0).toFixed(digits));
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

const parseTimestamp = (value) => {
  if (!value) return null;
  const normalised = String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const parsed = Date.parse(normalised);
  return Number.isFinite(parsed) ? parsed : null;
};

const json = (body, status, origin, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...(origin ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  } : {}), ...extraHeaders },
});

export const monitorStationIds = MONITOR_STATIONS;

export const parseMonitorPayload = (payload, fetchedAt = Date.now()) => {
  const monitors = payload?.data?.monitors || payload?.monitors || [];
  const observations = [];
  for (const monitor of monitors) {
    const properties = monitor.locationStop?.properties || monitor.stop?.properties || {};
    const stationId = finite(properties.name || properties.id || monitor.diva);
    const stationName = properties.title || properties.nameText || properties.name || `Station ${stationId || 'unknown'}`;
    for (const line of monitor.lines || []) {
      const lineId = String(line.name || line.line || '').toUpperCase();
      if (!LINES.includes(lineId)) continue;
      for (const departure of line.departures?.departure || line.departures || []) {
        const timing = departure.departureTime || departure.timing || {};
        const realTimestamp = parseTimestamp(timing.timeReal || timing.real);
        const plannedTimestamp = parseTimestamp(timing.timePlanned || timing.planned);
        const countdown = finite(timing.countdown);
        const realtimeTimestamp = realTimestamp || (plannedTimestamp || fetchedAt) + (countdown || 0) * 60000;
        const reportedDelaySeconds = realTimestamp && plannedTimestamp
          ? Math.round((realTimestamp - plannedTimestamp) / 1000) : null;
        const vehicle = departure.vehicle || {};
        observations.push({
          stationId, stationName, line: lineId,
          destination: vehicle.towards || line.towards || 'Unknown destination',
          direction: vehicle.direction || line.direction || null,
          countdownSeconds: countdown === null ? Math.max(0, Math.round((realtimeTimestamp - fetchedAt) / 1000)) : Math.max(0, Math.round(countdown * 60)),
          plannedTimestamp, realtimeTimestamp, reportedDelaySeconds,
          vehicleId: vehicle.id || vehicle.vehicleId || null,
          fetchedAt,
        });
      }
    }
  }
  return observations.filter((item) => item.line && Number.isFinite(item.realtimeTimestamp));
};

const delaySummary = (values) => {
  const delays = values.map((item) => item.reportedDelaySeconds).filter(Number.isFinite);
  return {
    observations: values.length,
    labelledObservations: delays.length,
    meanDelayMinutes: delays.length ? round(delays.reduce((sum, value) => sum + value, 0) / delays.length / 60, 2) : 0,
    maxDelayMinutes: delays.length ? round(Math.max(...delays) / 60, 1) : 0,
    delayedThreeMinutes: delays.filter((value) => value >= 180).length,
  };
};

const lineHeadway = (values) => {
  const byStation = new Map();
  for (const item of values) {
    const key = `${item.stationName}|${item.direction || item.destination}`;
    const list = byStation.get(key) || [];
    list.push(item);
    byStation.set(key, list);
  }
  let largestGap = null;
  let smallestGap = null;
  for (const [key, list] of byStation) {
    const sorted = [...list].sort((a, b) => a.countdownSeconds - b.countdownSeconds);
    for (let index = 1; index < sorted.length; index += 1) {
      const gap = sorted[index].countdownSeconds - sorted[index - 1].countdownSeconds;
      if (!largestGap || gap > largestGap.seconds) largestGap = { seconds: gap, station: key.split('|')[0] };
      if (!smallestGap || gap < smallestGap.seconds) smallestGap = { seconds: gap, station: key.split('|')[0] };
    }
  }
  const risk = clamp((largestGap?.seconds >= 720 ? 65 : 15) + (smallestGap?.seconds < 120 ? 20 : 0));
  const location = largestGap?.seconds >= 720
    ? `Gap near ${largestGap.station}`
    : smallestGap?.seconds < 120 ? `Trains close near ${smallestGap.station}` : 'No station-level anomaly';
  return { risk: Math.round(risk), status: risk >= 70 ? 'high' : risk >= 40 ? 'watch' : 'stable', location, largestGapMinutes: largestGap ? round(largestGap.seconds / 60, 1) : null, smallestGapMinutes: smallestGap ? round(smallestGap.seconds / 60, 1) : null };
};

export const buildSharedModels = ({ observations = [], fetchedAt = Date.now() } = {}) => {
  const hour = new Date(fetchedAt).getHours();
  const peak = (hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 19);
  const byLine = new Map(LINES.map((line) => [line, observations.filter((item) => item.line === line)]));
  const lines = LINES.map((line) => {
    const values = byLine.get(line) || [];
    const delay = delaySummary(values);
    const headway = lineHeadway(values);
    const crowdingScore = clamp(24 + (peak ? 24 : 0) + (headway.risk >= 65 ? 28 : 0) + delay.meanDelayMinutes * 6);
    const severity = delay.meanDelayMinutes >= 5 ? 'severe' : delay.meanDelayMinutes >= 3 ? 'major' : delay.meanDelayMinutes >= 1 ? 'minor' : 'on time';
    const action = headway.risk >= 70 || severity === 'severe'
      ? 'Prioritise incident review and passenger alternatives'
      : headway.risk >= 40 || severity === 'major'
        ? 'Monitor headway and prepare a passenger message'
        : 'Continue routine observation';
    return { line, delay, headway, crowding: { score: Math.round(crowdingScore), level: crowdingScore >= 70 ? 'high' : crowdingScore >= 45 ? 'medium' : 'low' }, severity, action };
  });
  return {
    generatedAt: fetchedAt,
    modelSource: 'Cloudflare Worker shared inference',
    status: 'live',
    lines,
    summary: {
      observations: observations.length,
      labelledObservations: observations.filter((item) => Number.isFinite(item.reportedDelaySeconds)).length,
      activeLines: lines.filter((item) => item.delay.observations > 0).length,
    },
  };
};

const archiveSnapshot = async (env, snapshot) => {
  if (!env?.RAIL_ARCHIVE?.put) return null;
  const date = new Date(snapshot.generatedAt);
  const key = `worker-snapshots/${date.toISOString().slice(0, 10)}/${date.toISOString().replace(/[:.]/g, '-')}.json`;
  await env.RAIL_ARCHIVE.put(key, JSON.stringify(snapshot), { httpMetadata: { contentType: 'application/json' } });
  return key;
};

export const handleNetworkSnapshot = async (request, env = {}, fetchImpl = fetch, executionContext = null) => {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || 'http://localhost:5173';
  if (request.method === 'OPTIONS') return json({}, 204, origin);
  if (request.method !== 'GET' || !url.pathname.endsWith('/network-snapshot')) return null;
  const upstream = new URL('https://www.wienerlinien.at/ogd_realtime/monitor');
  for (const id of MONITOR_STATIONS) upstream.searchParams.append('diva', String(id));
  let payload;
  try {
    const response = await fetchImpl(upstream, { headers: { Accept: 'application/json' } });
    if (!response.ok) return json({ error: `Wiener Linien monitor returned HTTP ${response.status}` }, 502, origin);
    payload = await response.json();
  } catch {
    return json({ error: 'Shared network snapshot is temporarily unavailable.' }, 502, origin);
  }
  const generatedAt = Date.now();
  const observations = parseMonitorPayload(payload, generatedAt);
  const models = buildSharedModels({ observations, fetchedAt: generatedAt });
  const snapshot = {
    generatedAt,
    source: 'wiener-linien-monitor',
    sourceServerTime: payload?.message?.serverTime || payload?.data?.message?.serverTime || null,
    observations,
    models,
  };
  if (executionContext?.waitUntil) executionContext.waitUntil(archiveSnapshot(env, snapshot).catch(() => null));
  return json(snapshot, 200, origin, {
    'Cache-Control': 'public, max-age=0, s-maxage=5, stale-while-revalidate=30',
    ETag: `W/"${generatedAt}"`,
  });
};

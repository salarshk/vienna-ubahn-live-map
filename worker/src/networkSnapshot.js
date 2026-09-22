const LINES = ['U1', 'U2', 'U3', 'U4', 'U6'];
// Tram arrivals use the same Wiener Linien monitor endpoint. They are kept
// separate from the U-Bahn model lines so the operations advisor remains
// scoped to the calibrated U-Bahn decisions while the shared snapshot still
// gives the map live tram departures.
const TRAM_LINES = ['1', '2', '5', '6', '9', '10', '11', '12', 'E4', '18', '25', '26', '27', '30', '31', '37', '38', '40', '41', '42', '43', '44', '46', '49', '52', '60', '62', '71', 'D', 'O', 'WLB', '26E', '71E'];
const LIVE_LINES = new Set([...LINES, ...TRAM_LINES]);
// The same distributed reference stations used by the browser position
// engine. One Worker request now aggregates the U-Bahn plus central tram
// corridors without polling every street stop.
const MONITOR_STATIONS = [
  60201481, 60201095, 60200657, 60201040, 60200031, 60201860, 60201859,
  60200910, 60200299, 60201299, 60201894, 60201182, 60201430,
  60201317, 60201468, 60201320, 60200743, 60201199, 60200425,
  60200956, 60200520, 60200820, 60201198, 60200357, 60201062,
  60201007, 60201499, 60201015, 60200615, 60201510, 60201705, 60201668,
  60200975, 60201184, 60201566, 60201349, 60200192,
];

const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, Number(value) || 0));
const round = (value, digits = 1) => Number((Number(value) || 0).toFixed(digits));
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
// Wiener Linien normally returns arrays, but a one-item result is sometimes
// encoded as a plain object. Treat both wire shapes identically so one unusual
// station response cannot crash the whole shared snapshot.
const asArray = (value) => {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
};

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
  const monitors = asArray(payload?.data?.monitors || payload?.monitors);
  const observations = [];
  for (const monitor of monitors) {
    const properties = monitor.locationStop?.properties || monitor.stop?.properties || {};
    const stationId = finite(properties.name || properties.id || monitor.diva);
    const stationName = properties.title || properties.nameText || properties.name || `Station ${stationId || 'unknown'}`;
    for (const line of asArray(monitor.lines)) {
      const lineId = String(line.name || line.line || '').toUpperCase();
      if (!LIVE_LINES.has(lineId)) continue;
      for (const departure of asArray(line.departures?.departure || line.departures)) {
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
          isLive: Boolean(realTimestamp),
          timingSource: realTimestamp ? 'official-wiener-linien-realtime' : 'wiener-linien-timetable',
          delaySource: reportedDelaySeconds === null ? null : 'wiener-linien-timeReal-minus-timePlanned',
          vehicleId: vehicle.id || vehicle.vehicleId || null,
          onStop: vehicle.onStop ?? line.onStop ?? null,
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

const buildPredictionLabModels = ({ lines, observations }) => {
  const multiHorizon = lines.map((item) => {
    const centre = item.delay.meanDelayMinutes;
    return {
      line: item.line,
      forecasts: [2, 5, 10, 15].map((horizonMinutes) => ({ horizonMinutes, minutes: round(centre, 1), lowMinutes: round(Math.max(0, centre - 1), 1), highMinutes: round(centre + 1, 1) })),
      samples: item.delay.labelledObservations,
      confidence: Math.round(clamp(35 + Math.min(45, item.delay.labelledObservations * 5) - (item.headway.risk >= 70 ? 8 : 0), 15, 85)),
      model: 'cloudflare shared multi-horizon delay', trainingStatus: 'shared baseline',
    };
  });
  const eta = observations.filter((item) => item.countdownSeconds >= 0).sort((a, b) => a.countdownSeconds - b.countdownSeconds).slice(0, 12).map((item, index) => ({
    id: `shared-${item.line}-${item.stationId}-${index}`,
    line: item.line,
    station: item.stationName,
    destination: item.destination,
    etaMinutes: round(item.countdownSeconds / 60, 1),
    lowMinutes: round(Math.max(0, item.countdownSeconds / 60 - 0.5), 1),
    highMinutes: round(item.countdownSeconds / 60 + 0.5, 1),
    confidence: item.isLive ? 72 : 42,
    evidence: item.isLive ? 'shared official live departure observation' : 'shared timetable observation',
  }));
  const dwell = observations.filter((item) => item.onStop === true).slice(0, 8).map((item) => ({
    line: item.line, station: item.stationName, predictedMinutes: 1, confidence: item.isLive ? 60 : 30, evidence: 'shared platform observation',
  }));
  const severity = lines.map((item) => ({ line: item.line, category: item.severity, score: item.delay.meanDelayMinutes >= 3 ? 60 : item.delay.meanDelayMinutes >= 1 ? 30 : 0, meanMinutes: item.delay.meanDelayMinutes, samples: item.delay.labelledObservations, evidence: `${item.delay.labelledObservations} shared delay observations` }));
  const delayBands = lines.map((item) => ({ line: item.line, low: Math.max(-2, round(item.delay.meanDelayMinutes - 1, 1)), typical: round(item.delay.meanDelayMinutes, 1), high: round(item.delay.meanDelayMinutes + 1, 1), confidence: 35 + Math.min(50, item.delay.labelledObservations * 4), evidence: 'shared line-level delay distribution' }));
  const cancellations = lines.map((item) => ({ line: item.line, risk: item.delay.observations < 2 ? 40 : 5, status: item.delay.observations < 2 ? 'watch' : 'low', action: item.delay.observations < 2 ? 'check next departure' : 'routine monitoring' })).sort((a, b) => b.risk - a.risk);
  const routes = lines.map((item) => ({ line: item.line, score: Math.round(clamp(100 - item.headway.risk * 0.45 - item.delay.meanDelayMinutes * 6)), risk: Math.round(clamp(item.headway.risk * 0.45 + item.delay.meanDelayMinutes * 6)), evidence: 'shared delay and headway signals' })).sort((a, b) => a.score - b.score);
  const transfers = [];
  const anomalies = lines.filter((item) => item.headway.risk >= 70 || item.delay.meanDelayMinutes >= 5).map((item) => ({ line: item.line, type: item.headway.risk >= 70 ? 'headway' : 'delay', detail: item.headway.location, severity: item.headway.risk >= 80 ? 'high' : 'watch' }));
  const uncertainty = lines.map((item) => ({ line: item.line, intervalMinutes: round(0.8 + (item.delay.labelledObservations ? 1 / Math.sqrt(item.delay.labelledObservations) : 1.5), 1), calibration: item.delay.labelledObservations ? 65 : 30, status: 'shared baseline' }));
  return {
    multiHorizon, eta, dwell,
    headways: lines.map((item) => ({ ...item.headway, line: item.line, probability: item.headway.risk, model: 'shared headway/bunching forecast', trainingStatus: 'shared baseline', evidence: item.headway.location })),
    recovery: [{ status: 'clear', window: 'No active incident in shared monitor snapshot', confidence: 30, evidence: 'shared network feed', model: 'shared recovery baseline' }],
    impact: [], severity, delayBands, transfers, routes, cancellations,
    crowd: lines.map((item) => ({ line: item.line, score: item.crowding.score, level: item.crowding.level, window: 'next 30–60 min' })),
    weather: { status: 'not connected', impact: 'Weather context remains a separate public feed', confidence: 0, horizon: '—' },
    events: { status: 'baseline', score: 0, confidence: 20, evidence: 'shared rail feed only' },
    sbahn: [], anomalies, uncertainty,
  };
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
    predictionLab: buildPredictionLabModels({ lines, observations }),
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
  const fetchMonitorBatch = async (stationIds) => {
    const upstream = new URL('https://www.wienerlinien.at/ogd_realtime/monitor');
    for (const id of stationIds) upstream.searchParams.append('diva', String(id));
    try {
      const response = await fetchImpl(upstream, { headers: { Accept: 'application/json' } });
      if (!response.ok) return { ok: false, status: response.status, payload: null };
      return { ok: true, status: response.status, payload: await response.json() };
    } catch (error) {
      return { ok: false, status: 0, payload: null, error };
    }
  };

  const batch = await fetchMonitorBatch(MONITOR_STATIONS);
  let payload = batch.payload;
  const initialMonitors = asArray(payload?.data?.monitors || payload?.monitors);
  const initialStationIds = new Set(initialMonitors.map((monitor) => {
    const properties = monitor?.locationStop?.properties || monitor?.stop?.properties || {};
    return String(properties.name || properties.id || monitor?.diva || '');
  }).filter(Boolean));
  // The Wiener Linien endpoint can return HTTP 200 with only the first ten
  // requested stations (instead of rejecting the long URL). Treat that as a
  // partial response; otherwise a valid-looking snapshot would evict most
  // trains from the browser every few seconds. Smaller batches are merged
  // below so one partial upstream response can never become the network view.
  const looksPartial = !batch.ok
    || initialStationIds.size < Math.ceil(MONITOR_STATIONS.length * 0.75);
  if (looksPartial) {
    // Retry as four smaller requests so a single bad/limited batch does not
    // blank the network-wide map. Successful chunks are merged into one
    // monitor payload.
    const chunks = [];
    for (let index = 0; index < MONITOR_STATIONS.length; index += 10) {
      chunks.push(MONITOR_STATIONS.slice(index, index + 10));
    }
    const results = await Promise.all(chunks.map(fetchMonitorBatch));
    const successful = results.filter((result) => result.ok && result.payload);
    if (!successful.length) {
      console.error('Wiener Linien monitor unavailable', batch.status || batch.error?.message || 'network error');
      return json({ error: `Wiener Linien monitor returned HTTP ${batch.status || 502}` }, 502, origin);
    }
    payload = {
      message: successful.find((result) => result.payload?.message)?.payload?.message || null,
      data: {
        monitors: successful.flatMap((result) => asArray(
          result.payload?.data?.monitors || result.payload?.monitors,
        )),
      },
    };
  }
  const generatedAt = Date.now();
  const observations = parseMonitorPayload(payload, generatedAt);
  const models = buildSharedModels({ observations, fetchedAt: generatedAt });
  const returnedMonitors = asArray(payload?.data?.monitors || payload?.monitors);
  const returnedStationIds = new Set(returnedMonitors.map((monitor) => {
    const properties = monitor?.locationStop?.properties || monitor?.stop?.properties || {};
    return String(properties.name || properties.id || monitor?.diva || '');
  }).filter(Boolean));
  const completeness = {
    requestedStations: MONITOR_STATIONS.length,
    returnedStations: returnedStationIds.size,
    // A station can legitimately have no qualifying live departure, so use a
    // conservative coverage floor rather than requiring every requested id.
    // Anything below it is a partial upstream response and must not evict the
    // browser's last complete station set.
    complete: returnedStationIds.size >= Math.ceil(MONITOR_STATIONS.length * 0.65),
  };
  const snapshot = {
    generatedAt,
    source: 'wiener-linien-monitor',
    sourceServerTime: payload?.message?.serverTime || payload?.data?.message?.serverTime || null,
    observations,
    models,
    completeness,
  };
  if (executionContext?.waitUntil) executionContext.waitUntil(archiveSnapshot(env, snapshot).catch(() => null));
  return json(snapshot, 200, origin, {
    // The map marks observations older than three seconds as waiting. Keep the
    // edge cache to one second and never serve a stale-while-revalidate copy:
    // a stale response must not be labelled as fresh telemetry.
    'Cache-Control': 'public, max-age=0, s-maxage=1',
    'X-Snapshot-Generated-At': String(generatedAt),
    ETag: `W/"${generatedAt}"`,
  });
};

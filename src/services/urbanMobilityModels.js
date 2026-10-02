// Transparent, low-cost models for the city-context layer.  These are not
// trained claims of traffic control: they combine observed feeds with a
// time-of-day prior and always expose the evidence and confidence used.

const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, Number(value) || 0));
const finite = (...values) => values.map(Number).find(Number.isFinite);
const rows = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.features)) return value.features.map((feature) => feature?.properties || feature);
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.items)) return value.items;
  return [];
};

const first = (context, keys) => keys.map((key) => context?.[key]).find((value) => value != null) || {};
const peak = (now) => {
  const date = new Date(now);
  const hour = date.getHours() + date.getMinutes() / 60;
  return [1, 2, 3, 4, 5].includes(date.getDay()) && ((hour >= 7 && hour <= 9.5) || (hour >= 16 && hour <= 19));
};

export const parseUrbanTraffic = (context = {}) => {
  const raw = first(context, ['urbanTraffic', 'evis-traffic', 'evisTraffic', 'vienna-traffic-counters', 'viennaTraffic']);
  const records = rows(raw?.observations || raw?.measurements || raw?.records || raw);
  const speeds = records.map((item) => finite(item.speed, item.avgSpeed, item.averageSpeed, item.velocity, item.trafficSpeed)).filter(Number.isFinite);
  const delays = records.map((item) => finite(item.delay, item.delaySeconds, item.travelTimeLoss, item.lossTime)).filter(Number.isFinite);
  const incidents = records.filter((item) => /incident|accident|closure|roadwork|baustell|stau|sperr/i.test(JSON.stringify(item))).length;
  const congestion = records.filter((item) => item.congested === true || /congest|slow|jam|stau|baustell/i.test(JSON.stringify(item))).length;
  const meanSpeed = speeds.length ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : null;
  const meanDelay = delays.length ? delays.reduce((sum, value) => sum + value, 0) / delays.length : null;
  const ratio = records.length ? congestion / records.length : 0;
  const score = clamp(ratio * 75 + Math.min(20, (meanDelay || 0) * 2) + incidents * 8);
  return {
    observations: records.length,
    meanSpeed: meanSpeed == null ? null : Number(meanSpeed.toFixed(1)),
    meanDelaySeconds: meanDelay == null ? null : Number(meanDelay.toFixed(1)),
    incidents,
    congestedSegments: congestion,
    congestionScore: Math.round(score),
    status: records.length ? 'observed' : 'baseline',
    evidence: records.length ? `${records.length} road observations · ${incidents} incident signals` : 'No live road measurements; time-of-day prior only',
  };
};

export const parseUrbanEvents = (context = {}, now = Date.now()) => {
  const raw = first(context, ['urbanEvents', 'vienna-events', 'viennaEvents', 'events']);
  const eventRows = rows(raw?.events || raw?.records || raw);
  const active = eventRows.filter((event) => {
    const start = Date.parse(event.start || event.startDate || event.begin || '') || 0;
    const end = Date.parse(event.end || event.endDate || event.finish || '') || Number.POSITIVE_INFINITY;
    return !start || (start - 6 * 3600000 <= now && now <= end + 3 * 3600000);
  });
  const attendance = active.map((event) => finite(event.attendance, event.expectedAttendance, event.capacity, event.visitors)).filter(Number.isFinite);
  const attendanceScore = attendance.reduce((sum, value) => sum + Math.min(100, value / 500), 0);
  return {
    total: eventRows.length,
    active: active.length,
    expectedAttendance: attendance.length ? attendance.reduce((sum, value) => sum + value, 0) : null,
    score: Math.round(clamp(active.length * 18 + attendanceScore)),
    status: eventRows.length ? 'observed' : 'baseline',
    events: active.slice(0, 24).map((event) => ({
      id: event.id || event.eventId || event.title || event.name || `event-${active.indexOf(event)}`,
      title: event.title || event.name || event.event || 'Vienna event',
      venue: event.venue || event.location || event.address || null,
      lat: finite(event.lat, event.latitude, event.y),
      lon: finite(event.lon, event.lng, event.longitude, event.x),
      attendance: finite(event.attendance, event.expectedAttendance, event.capacity, event.visitors),
    })),
    evidence: eventRows.length ? `${active.length} active event records` : 'No event feed connected; event impact is neutral',
  };
};

export const buildUrbanMobilityForecast = ({ context = {}, railRisk = 0, now = Date.now() } = {}) => {
  const traffic = parseUrbanTraffic(context);
  const events = parseUrbanEvents(context, now);
  const weather = context.weatherNowcast || {};
  const weatherBoost = clamp((Number(weather.next60MinPrecipitation) || 0) * 8 + (Number(weather.windSpeed) || 0) * 1.5, 0, 18);
  const peakBoost = peak(now) ? 12 : 0;
  const base = clamp(traffic.congestionScore + events.score * 0.45 + weatherBoost + peakBoost);
  const confidence = traffic.observations || events.total ? Math.round(clamp(52 + Math.min(32, traffic.observations * 2) + Math.min(12, events.active * 3))) : 28;
  const horizons = [15, 30, 60].map((minutes, index) => ({
    minutes,
    score: Math.round(clamp(base + index * (peak(now) ? 4 : 1) + Number(railRisk || 0) * 0.08)),
    label: base >= 70 ? 'high' : base >= 40 ? 'watch' : 'routine',
  }));
  const stationPressure = Math.round(clamp(events.score * 0.65 + traffic.congestionScore * 0.15 + Number(railRisk || 0) * 0.2));
  const multimodalRisk = Math.round(clamp(traffic.congestionScore * 0.45 + events.score * 0.35 + Number(railRisk || 0) * 0.2));
  const warnings = [];
  if (traffic.incidents) warnings.push(`${traffic.incidents} road incident signal${traffic.incidents === 1 ? '' : 's'} may slow surface access`);
  if (events.active) warnings.push(`${events.active} active event${events.active === 1 ? '' : 's'} may raise station pressure`);
  if (weatherBoost >= 10) warnings.push('Weather may lengthen outdoor transfers');
  return {
    generatedAt: now,
    status: traffic.observations || events.total ? 'observed-plus-prior' : 'baseline',
    confidence,
    traffic,
    events,
    horizons,
    stationPressure,
    multimodalRisk,
    warnings,
    evidence: [traffic.evidence, events.evidence, peak(now) ? 'weekday peak prior' : 'off-peak prior'],
    limitations: 'Road counter locations are public metadata; measured speed/incident values appear only when a live EVIS or traffic-counter values feed is configured.',
  };
};

export default buildUrbanMobilityForecast;

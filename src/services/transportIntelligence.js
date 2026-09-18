// Cross-network transport intelligence. These are deliberately transparent
// baselines: they join optional road, airport, event, environment and sharing
// context with the rail observations already in the app without pretending to
// have operator-grade traffic control or passenger-count telemetry.

const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, Number(value) || 0));
const number = (...values) => values.map((value) => Number(value)).find(Number.isFinite);
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const rowsFrom = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.features)) return value.features.map((feature) => feature?.properties || feature);
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.items)) return value.items;
  return [];
};
const contextValue = (context, ...keys) => keys.map((key) => context?.[key]).find((value) => value != null) || {};
const peakPeriod = (now = Date.now()) => {
  const date = new Date(now);
  const hour = date.getHours() + date.getMinutes() / 60;
  return [1, 2, 3, 4, 5].includes(date.getDay()) && ((hour >= 7 && hour <= 9.5) || (hour >= 16 && hour <= 19));
};

export const parseTrafficContext = (context = {}) => {
  const raw = contextValue(context, 'evis-traffic', 'evisTraffic', 'vienna-traffic-counters', 'viennaTraffic');
  const records = rowsFrom(raw);
  const speeds = records.map((row) => number(row.speed, row.avgSpeed, row.averageSpeed, row.velocity, row.trafficSpeed)).filter(Number.isFinite);
  const delays = records.map((row) => number(row.delay, row.delaySeconds, row.travelTimeLoss, row.lossTime)).filter(Number.isFinite);
  const congested = records.filter((row) => /congest|stau|slow|jam|closed|roadwork|baustell/i.test(JSON.stringify(row))).length;
  const incidents = records.filter((row) => /incident|event|closure|accident|baustell|sperr/i.test(JSON.stringify(row))).length;
  const meanSpeed = speeds.length ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : null;
  const meanDelay = delays.length ? delays.reduce((sum, value) => sum + value, 0) / delays.length : null;
  const congestionScore = clamp((congested / Math.max(1, records.length)) * 100 + (meanDelay == null ? 0 : Math.min(50, meanDelay * 2)) + incidents * 8);
  return {
    observations: records.length,
    meanSpeed,
    meanDelay,
    congestionScore: Math.round(congestionScore),
    congestedSegments: congested,
    incidents,
    status: records.length ? 'observed' : 'baseline',
    evidence: records.length ? `${records.length} road observations · ${incidents} incident signals` : 'No road feed connected; using rail-only baseline',
  };
};

export const predictTrafficAwareTrams = ({ tramPredictions = [], context = {}, issues = [], now = Date.now() } = {}) => {
  const traffic = parseTrafficContext(context);
  const issueLines = new Set(issues.filter((issue) => issue?.line && !/^U|^S/i.test(String(issue.line))).map((issue) => String(issue.line)));
  return tramPredictions.map((tram) => {
    const streetExposure = traffic.congestionScore * 0.65;
    const issueBoost = issueLines.has(String(tram.line)) ? 15 : 0;
    const risk = clamp(Math.round(tram.pressure * 0.45 + streetExposure + issueBoost));
    const extraMinutes = Number((risk / 35).toFixed(1));
    return {
      line: tram.line,
      risk,
      level: risk >= 70 ? 'high' : risk >= 40 ? 'watch' : 'routine',
      extraMinutes,
      traffic,
      confidence: traffic.observations ? 64 : 34,
      evidence: `${traffic.evidence}${issueBoost ? ' · live tram anomaly' : ''}`,
      generatedAt: now,
    };
  });
};

export const parseAirportActivity = (context = {}) => {
  const raw = contextValue(context, 'airport-flights', 'airportFlights', 'opensky', 'openSky');
  const arrivals = rowsFrom(raw?.arrivals || raw?.arrival || raw);
  const departures = rowsFrom(raw?.departures || raw?.departure);
  const states = rowsFrom(raw?.states || raw?.state_vectors);
  const approaching = states.filter((row) => {
    const altitude = number(row.baro_altitude, row.baroAltitude, row.altitude, row.geoaltitude);
    const onGround = row.on_ground ?? row.onGround;
    return onGround !== true && altitude != null && altitude < 4000;
  }).length;
  const explicitArrivals = arrivals.length;
  const explicitDepartures = departures.length;
  const activity = explicitArrivals + explicitDepartures + approaching;
  const pressureScore = clamp(activity * 8 + approaching * 6);
  return {
    arrivals: explicitArrivals,
    departures: explicitDepartures,
    approaching,
    activity,
    pressureScore: Math.round(pressureScore),
    status: activity ? 'observed' : 'baseline',
    confidence: explicitArrivals || explicitDepartures ? 72 : approaching ? 44 : 20,
    evidence: explicitArrivals || explicitDepartures
      ? `${explicitArrivals} arrivals · ${explicitDepartures} departures in supplied airport feed`
      : approaching ? `${approaching} low-altitude aircraft observations; arrival status is inferred` : 'No airport feed connected',
  };
};

export const predictAirportArrivalWave = ({ context = {}, now = Date.now() } = {}) => {
  const airport = parseAirportActivity(context);
  const peak = peakPeriod(now);
  const score = clamp(airport.pressureScore + (peak ? 8 : 0));
  return {
    ...airport,
    railPressureScore: Math.round(clamp(score * 0.85)),
    railPressureLevel: score >= 70 ? 'high' : score >= 35 ? 'watch' : 'routine',
    corridors: ['S7 / airport corridor', 'CAT / Wien Mitte', 'airport bus and taxi fallback'],
    generatedAt: now,
  };
};

export const parseEventContext = (context = {}) => {
  const raw = contextValue(context, 'vienna-events', 'viennaEvents', 'events');
  const records = rowsFrom(raw);
  const active = records.filter((event) => {
    const text = JSON.stringify(event);
    return !/cancel|abgesagt/i.test(text);
  });
  const attendance = active.map((event) => number(event.expectedAttendance, event.attendance, event.capacity, event.visitors)).filter(Number.isFinite);
  const attendanceScore = attendance.length ? Math.min(70, attendance.reduce((sum, value) => sum + value, 0) / 100) : 0;
  const locations = active.map((event) => clean(event.location || event.venue || event.address || event.name)).filter(Boolean).slice(0, 4);
  return {
    events: active.length,
    attendanceScore,
    pressureScore: Math.round(clamp(active.length * 8 + attendanceScore)),
    locations,
    status: active.length ? 'observed' : 'baseline',
    evidence: active.length ? `${active.length} event records${attendance.length ? ` · ${Math.round(attendance.reduce((sum, value) => sum + value, 0)).toLocaleString()} expected attendees` : ''}` : 'No event feed connected; using calendar and service baseline',
  };
};

export const predictEventCrowding = ({ context = {}, disruptions = [], now = Date.now() } = {}) => {
  const events = parseEventContext(context);
  const peak = peakPeriod(now);
  const disruptionBoost = disruptions.length * 8;
  const score = clamp(Math.round(events.pressureScore + (peak ? 12 : 0) + disruptionBoost));
  return { ...events, score, level: score >= 70 ? 'high' : score >= 40 ? 'watch' : 'routine', confidence: events.events ? 58 : 34, generatedAt: now };
};

export const estimateEnvironmentalComfort = ({ context = {}, now = Date.now() } = {}) => {
  const weather = context.weatherNowcast || context.weather || {};
  const air = context.airQuality || {};
  const rain = number(weather.next60MinPrecipitation, weather.precipitation) || 0;
  const wind = number(weather.windSpeed, weather.wind) || 0;
  const temperature = number(weather.temperature, weather.temp);
  const pm10 = number(air.pm10, air.PM10) || 0;
  const no2 = number(air.no2, air.NO2) || 0;
  const penalty = rain * 8 + Math.min(20, wind * 1.5) + Math.min(40, pm10 * 1.2) + Math.min(25, no2 * 0.45) + (temperature != null && (temperature < 0 || temperature > 30) ? 12 : 0);
  const score = Math.round(clamp(100 - penalty));
  const available = [rain, wind, temperature, pm10, no2].some((value) => value !== 0);
  return {
    score,
    level: score < 40 ? 'poor' : score < 70 ? 'moderate' : 'comfortable',
    rain, wind, temperature, pm10, no2,
    recommendation: score < 40 ? 'Prefer sheltered transfers and minimise outdoor waiting' : score < 70 ? 'Use a shorter or sheltered walking connection where possible' : 'Normal outdoor transfer conditions',
    confidence: available ? 66 : 22,
    status: available ? 'observed' : 'baseline',
    generatedAt: now,
  };
};

export const buildMultimodalFallbacks = ({ context = {}, lineRisk = 0, disruptions = [], origin = '', destination = '', now = Date.now() } = {}) => {
  const bikes = context.bikeShare || {};
  const taxiStands = rowsFrom(context.taxiStands || context['taxi-stands']);
  const options = [];
  const disruptionLevel = clamp(lineRisk + disruptions.length * 20);
  if (bikes.availableBikes > 0) options.push({ mode: 'bike', title: 'WienMobil Rad', detail: `${bikes.availableBikes} bikes available${bikes.availableDocks == null ? '' : ` · ${bikes.availableDocks} docks`}`, score: clamp(78 - disruptionLevel * 0.2), evidence: 'live GBFS station status' });
  if (taxiStands.length) options.push({ mode: 'taxi', title: 'Taxi stand fallback', detail: `${taxiStands.length} mapped taxi stands near the network`, score: clamp(62 - disruptionLevel * 0.1), evidence: 'Vienna taxi-stand locations' });
  options.push({ mode: 'rail', title: 'Stay on rail with verification', detail: `${origin || 'Origin'} → ${destination || 'destination'} · verify the next departure`, score: clamp(70 - disruptionLevel * 0.35), evidence: 'current rail risk and live departures' });
  options.push({ mode: 'walk', title: 'Walking transfer', detail: 'Use only for short station-to-station links; distance is not calculated here', score: clamp(45 - disruptionLevel * 0.15), evidence: 'fallback without live road or pedestrian timing' });
  return options.sort((a, b) => b.score - a.score).map((item, index) => ({ ...item, rank: index + 1, generatedAt: now }));
};

export default {
  parseTrafficContext,
  predictTrafficAwareTrams,
  parseAirportActivity,
  predictAirportArrivalWave,
  parseEventContext,
  predictEventCrowding,
  estimateEnvironmentalComfort,
  buildMultimodalFallbacks,
};

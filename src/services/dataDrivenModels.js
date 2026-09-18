// Data-driven model catalogue for the external context feeds.  These are
// deliberately transparent baselines: they expose the signal and its source
// while labels are collected for future supervised training.

import {
  buildMultimodalFallbacks,
  estimateEnvironmentalComfort,
  predictAirportArrivalWave,
  predictEventCrowding,
  predictTrafficAwareTrams,
} from './transportIntelligence';
import { buildTramPredictions } from './tramIntelligence';

const LINES = ['U1', 'U2', 'U3', 'U4', 'U6'];
const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, Number(value) || 0));
const round = (value, digits = 0) => Number((Number(value) || 0).toFixed(digits));
const statusLabel = (sourceIds, sources, context, fallback = true) => {
  const live = sourceIds.some((id) => sources?.[id]?.status === 'live' || context?.[id]);
  if (live) return 'live';
  return fallback ? 'baseline' : 'awaiting data';
};
const contextText = (value) => JSON.stringify(value || '').toLowerCase();
const riskLabel = (score) => score >= 70 ? 'high' : score >= 40 ? 'watch' : 'low';
const peak = (now) => {
  const hour = new Date(now).getHours();
  return (hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 19);
};

export const DATA_MODEL_CATALOG = [
  { id: 'weather-delay', name: 'Weather-aware delay', description: 'Adds rain, wind and temperature pressure to the short-horizon delay risk.', inputs: 'GeoSphere nowcast + live delays', source: 'geosphere-nowcast' },
  { id: 'weather-dwell', name: 'Weather-aware dwell time', description: 'Estimates longer platform stops during adverse weather and crowd pressure.', inputs: 'Weather + platform observations', source: 'geosphere-nowcast' },
  { id: 'holiday-demand', name: 'Holiday demand', description: 'Adjusts demand expectations for public and school holidays versus working days.', inputs: 'OpenHolidays + time of day', source: 'holidays' },
  { id: 'event-impact', name: 'Event impact', description: 'Detects event-like demand surges and projects station pressure.', inputs: 'Vienna events + service notices', source: 'vienna-events' },
  { id: 'traffic-propagation', name: 'Traffic-to-rail propagation', description: 'Links surface incidents and road pressure to access and rail delay risk.', inputs: 'EVIS/ITS Vienna + rail alerts', source: 'evis-traffic' },
  { id: 'station-crowding', name: 'Station crowding nowcast', description: 'Ranks station pressure from departures, gaps, peak periods and context signals.', inputs: 'Departures + headways + context', source: 'passenger-counts' },
  { id: 'multimodal-fallback', name: 'Multimodal fallback', description: 'Suggests resilient bike or multimodal alternatives when rail risk rises.', inputs: 'Bike availability + rail risk', source: 'wienmobil-rad' },
  { id: 'bike-availability', name: 'Bike availability forecast', description: 'Estimates whether nearby bike capacity can absorb a disrupted journey.', inputs: 'GBFS station status', source: 'wienmobil-rad' },
  { id: 'air-quality-comfort', name: 'Air-quality comfort', description: 'Turns pollutant observations into an outdoor transfer comfort signal.', inputs: 'Vienna air-monitoring network', source: 'air-quality' },
  { id: 'disruption-propagation', name: 'Disruption propagation', description: 'Forecasts which lines and connecting services are likely to inherit an incident.', inputs: 'Alerts + live delay + topology', source: 'vienna-events' },
  { id: 'headway-bunching', name: 'Headway & bunching forecast', description: 'Predicts the next gap or close pair and identifies its likely station area.', inputs: 'Live departures and inferred positions', source: 'wiener-linien' },
  { id: 'sbahn-delay', name: 'S-Bahn delay model', description: 'Builds a separate S-Bahn delay estimate from timetable and archived ÖBB observations.', inputs: 'ÖBB journey history + schedule', source: 'oebb-train-history' },
  { id: 'connection-risk', name: 'Connection-risk model', description: 'Estimates the probability that a passenger will catch a transfer.', inputs: 'Arrival/departure margins + uncertainty', source: 'vao-routing' },
  { id: 'recovery-duration', name: 'Recovery-duration model', description: 'Estimates how long a disruption will continue before service normalises.', inputs: 'Incident text + historical episodes', source: 'oebb-train-history' },
  { id: 'passenger-demand', name: 'Passenger demand forecast', description: 'Forecasts demand pressure by line and time window without claiming occupancy.', inputs: 'Counts when available + service proxy', source: 'passenger-counts' },
  { id: 'maintenance-anomaly', name: 'Maintenance/anomaly model', description: 'Flags telemetry patterns that resemble a vehicle or infrastructure issue.', inputs: 'Vehicle telemetry + freshness', source: 'vehicle-telemetry' },
  { id: 'fleet-formation', name: 'Fleet formation model', description: 'Estimates train formation and capacity implications for the live fleet.', inputs: 'Vehicle telemetry + vehicle identities', source: 'vehicle-telemetry' },
  { id: 'mobility-flow', name: 'Mobility-flow model', description: 'Nowcasts citywide movement pressure around stations and corridors.', inputs: 'Aggregated mobility movement', source: 'mobile-movement' },
  { id: 'control-room-decisions', name: 'Control-room decision model', description: 'Converts model outputs into prioritised operational actions for each line.', inputs: 'All available signals', source: 'all' },
  { id: 'tram-operations', name: 'Tram operations baseline', description: 'Separates street-running tram delay, headway and disruption pressure from U-Bahn conditions.', inputs: 'Tram departures + inferred vehicles + notices', source: 'wiener-linien' },
  { id: 'tram-crowding', name: 'Tram crowding proxy', description: 'Estimates tram pressure from near departures, gaps, peak time and passenger reports.', inputs: 'Tram departures + service pattern + reports', source: 'wiener-linien' },
  { id: 'tram-traffic-delay', name: 'Traffic-aware tram delay', description: 'Adds road congestion and incident pressure to the street-running tram baseline.', inputs: 'Tram departures + EVIS/traffic counters + anomalies', source: 'evis-traffic' },
  { id: 'airport-arrival-wave', name: 'Airport arrival-wave pressure', description: 'Estimates pressure on S7, CAT, airport buses and taxi fallbacks from airport activity.', inputs: 'Airport arrivals or aircraft activity + rail state', source: 'airport-flights' },
  { id: 'event-crowding', name: 'Event crowd forecast', description: 'Projects station pressure from nearby event records, attendance signals and disruption overlap.', inputs: 'Vienna events + calendar + rail pressure', source: 'vienna-events' },
  { id: 'environmental-comfort', name: 'Environmental transfer comfort', description: 'Ranks outdoor transfer conditions using rain, wind, temperature and pollutants.', inputs: 'GeoSphere weather + air quality', source: 'air-quality,geosphere-nowcast' },
];

const averageDelay = (arrivals) => {
  const values = arrivals.map((item) => Number(item.reportedDelaySeconds) / 60).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
};

export const buildDataDrivenModels = ({ context = {}, sources = {}, arrivals = [], issues = [], disruptions = [], crowding = [], vehicles = [], now = Date.now(), remoteModels = null } = {}) => {
  const weather = context.weatherNowcast || {};
  const holidays = context.holidays || {};
  const air = context.airQuality || {};
  const bikes = context.bikeShare || {};
  const weatherScore = clamp((Number(weather.next60MinPrecipitation) || 0) * 20 + (Number(weather.windSpeed) || 0) * 2 + (Number(weather.temperature) < 0 ? 15 : 0));
  const incidentScore = clamp(disruptions.length * 25 + issues.length * 12 + averageDelay(arrivals) * 6);
  const peakScore = peak(now) ? 25 : 0;
  const holidayAdjustment = holidays.isPublicHoliday ? -25 : holidays.isSchoolHoliday ? -12 : 0;
  const crowdScore = clamp((crowding.reduce((sum, item) => sum + (Number(item.score) || 0), 0) / Math.max(1, crowding.length)) + holidayAdjustment + peakScore + weatherScore * 0.2);
  const source = (id) => sources?.[id]?.status === 'live' || Boolean(context?.[id]);
  const make = (id, output, score, extra = {}) => {
    const descriptor = DATA_MODEL_CATALOG.find((item) => item.id === id);
    const sourceIds = descriptor.source === 'all' ? [] : descriptor.source.split(',');
    return { ...descriptor, status: statusLabel(sourceIds, sources, context, true), score: round(clamp(score)), risk: riskLabel(score), output, ...extra };
  };
  const impactedLines = LINES.filter((line) => disruptions.some((item) => item.lines?.includes(line)) || issues.some((item) => item.line === line));
  const tramArrivals = arrivals.filter((item) => item.isLive && !/^U|^S/i.test(String(item.line || '')));
  const tramIssues = issues.filter((item) => !/^U|^S/i.test(String(item.line || '')));
  const tramPredictions = buildTramPredictions({ arrivals, vehicles, issues, disruptions, now });
  const trafficTrams = predictTrafficAwareTrams({ tramPredictions, context, issues, now });
  const airportWave = predictAirportArrivalWave({ context, now });
  const eventCrowding = predictEventCrowding({ context, disruptions, now });
  const environmental = estimateEnvironmentalComfort({ context, now });
  const fallbackOptions = buildMultimodalFallbacks({ context, lineRisk: incidentScore, disruptions, now });
  const decisions = LINES.map((line) => {
    const lineIssues = issues.filter((item) => item.line === line);
    const lineDelay = averageDelay(arrivals.filter((item) => item.line === line));
    const score = clamp(lineIssues.length * 25 + lineDelay * 8 + (disruptions.some((item) => item.lines?.includes(line)) ? 35 : 0));
    return { line, score: round(score), action: score >= 70 ? 'Prioritise incident response and passenger diversions' : score >= 40 ? 'Monitor headway and prepare a short-turn/fallback' : 'Keep normal regulation; watch the next observations' };
  });

  const localModels = [
    make('weather-delay', `${riskLabel(weatherScore)} delay pressure · +${round(weatherScore / 20, 1)} min risk`, weatherScore, { confidence: source('geosphere-nowcast') ? 72 : 38 }),
    make('weather-dwell', `${riskLabel(weatherScore * 0.9)} dwell pressure · ${round(1 + weatherScore / 100, 1)}× baseline`, weatherScore * 0.9, { confidence: source('geosphere-nowcast') ? 68 : 35 }),
    make('holiday-demand', `${riskLabel(clamp(50 + peakScore + holidayAdjustment))} demand · ${holidays.isPublicHoliday ? 'public holiday' : holidays.isSchoolHoliday ? 'school holiday' : peak(now) ? 'peak period' : 'working-day baseline'}`, clamp(50 + peakScore + holidayAdjustment), { confidence: source('holidays') ? 80 : 42 }),
    make('event-impact', `${riskLabel(clamp(incidentScore + (contextText(context['vienna-events']).includes('event') ? 25 : 0)))} station pressure`, incidentScore + (contextText(context['vienna-events']).includes('event') ? 25 : 0), { confidence: source('vienna-events') ? 70 : 40 }),
    make('traffic-propagation', `${riskLabel(incidentScore * 0.7)} access-to-rail propagation · ${impactedLines.length ? impactedLines.join(', ') : 'no line currently exposed'}`, incidentScore * 0.7, { confidence: source('evis-traffic') ? 65 : 34 }),
    make('station-crowding', `${riskLabel(crowdScore)} pressure · ${round(crowdScore)}/100 proxy`, crowdScore, { confidence: source('passenger-counts') ? 78 : 52 }),
    make('multimodal-fallback', `${fallbackOptions[0]?.title || 'Rail fallback'} ranked first · ${fallbackOptions.length} options`, clamp(100 - (fallbackOptions[0]?.score || 40)), { confidence: source('wienmobil-rad') ? 76 : 42, fallbackOptions }),
    make('bike-availability', bikes.availableBikes == null ? 'Awaiting station-level bike availability' : `${bikes.availableBikes} bikes · ${bikes.availableDocks ?? '—'} docks`, bikes.availableBikes == null ? 0 : clamp(100 - (bikes.availableBikes / Math.max(1, bikes.availableDocks + bikes.availableBikes)) * 100), { confidence: source('wienmobil-rad') ? 90 : 25 }),
    make('air-quality-comfort', air.pm10 == null && air.no2 == null ? 'Awaiting pollutant observation' : `PM10 ${air.pm10 ?? '—'} · NO₂ ${air.no2 ?? '—'} · outdoor comfort ${riskLabel((air.pm10 || 0) * 2)}`, clamp((air.pm10 || 0) * 2), { confidence: source('air-quality') ? 86 : 25 }),
    make('disruption-propagation', `${riskLabel(incidentScore)} propagation · ${impactedLines.length ? impactedLines.join(', ') : 'network clear'}`, incidentScore, { confidence: 72 }),
    make('headway-bunching', `${issues.length ? issues.length : 'No'} live gap/bunching signal${issues.length === 1 ? '' : 's'}`, clamp(issues.length * 28), { confidence: 78 }),
    make('sbahn-delay', context['oebb-train-history'] ? 'ÖBB archive context connected' : 'Schedule-based S-Bahn baseline; live labels not connected', averageDelay(arrivals.filter((item) => /^S/i.test(item.line))), { confidence: source('oebb-train-history') ? 68 : 30 }),
    make('connection-risk', `${riskLabel(clamp(incidentScore + crowdScore * 0.25))} transfer risk · verify platform margin`, incidentScore + crowdScore * 0.25, { confidence: 58 }),
    make('recovery-duration', disruptions.length ? `${Math.max(5, Math.round(12 + incidentScore / 4))} min estimated recovery window` : 'No active incident; normal recovery state', disruptions.length ? incidentScore : 5, { confidence: source('oebb-train-history') ? 64 : 42 }),
    make('passenger-demand', `${riskLabel(crowdScore)} demand proxy · ${round(crowdScore)}/100`, crowdScore, { confidence: source('passenger-counts') ? 82 : 48 }),
    make('maintenance-anomaly', `${vehicles.filter((item) => Number(item.lastDataAgeSeconds) > 30 || Number(item.positionUncertaintyMetres) > 1000).length} vehicle freshness/position anomalies`, vehicles.filter((item) => Number(item.lastDataAgeSeconds) > 30 || Number(item.positionUncertaintyMetres) > 1000).length * 25, { confidence: source('vehicle-telemetry') ? 74 : 45 }),
    make('fleet-formation', `${new Set(vehicles.map((item) => item.id).filter(Boolean)).size} live vehicle identities; formation feed ${source('vehicle-telemetry') ? 'connected' : 'not connected'}`, source('vehicle-telemetry') ? 35 : 0, { confidence: source('vehicle-telemetry') ? 80 : 24 }),
    make('mobility-flow', context['mobile-movement'] ? 'Aggregated city movement context connected' : 'Awaiting privacy-preserving mobility partner feed', peakScore + incidentScore * 0.2, { confidence: source('mobile-movement') ? 70 : 20 }),
    make('control-room-decisions', decisions.map((item) => `${item.line}: ${item.action}`).join(' · '), Math.max(...decisions.map((item) => item.score), 0), { confidence: 70, decisions }),
    make('tram-operations', `${tramArrivals.length} live tram departures · ${tramIssues.length} tram headway signals`, clamp(tramArrivals.length * 4 + tramIssues.length * 20), { confidence: tramArrivals.length ? 62 : 25 }),
    make('tram-crowding', `${riskLabel(clamp(crowdScore * 0.8 + tramArrivals.length * 2))} tram pressure proxy`, clamp(crowdScore * 0.8 + tramArrivals.length * 2), { confidence: tramArrivals.length ? 58 : 28 }),
    make('tram-traffic-delay', `${riskLabel(Math.max(...trafficTrams.map((item) => item.risk), 0))} road pressure · ${trafficTrams.filter((item) => item.level !== 'routine').length} tram lines to watch`, Math.max(...trafficTrams.map((item) => item.risk), 0), { confidence: trafficTrams.some((item) => item.traffic.observations) ? 64 : 34, trafficTrams }),
    make('airport-arrival-wave', `${airportWave.railPressureLevel} airport corridor pressure · ${airportWave.activity} activity observations`, airportWave.railPressureScore, { confidence: airportWave.confidence, airportWave }),
    make('event-crowding', `${eventCrowding.level} event pressure · ${eventCrowding.events} event records`, eventCrowding.score, { confidence: eventCrowding.confidence, eventCrowding }),
    make('environmental-comfort', `${environmental.level} outdoor transfer conditions · ${environmental.score}/100`, 100 - environmental.score, { confidence: environmental.confidence, environmental }),
  ];
  const remoteLines = Array.isArray(remoteModels?.lines) ? remoteModels.lines : [];
  if (!remoteLines.length) return localModels;
  const lineText = (field, formatter) => remoteLines.map((line) => formatter(line[field], line.line)).join(' · ');
  return localModels.map((item) => {
    const shared = {
      'weather-delay': remoteModels,
      'station-crowding': remoteModels,
      'headway-bunching': remoteModels,
      'disruption-propagation': remoteModels,
      'control-room-decisions': remoteModels,
    }[item.id];
    if (!shared) return item;
    let output = item.output;
    if (item.id === 'weather-delay') output = 'Shared Worker model active · ' + lineText('delay', (value, line) => `${line} ${value?.meanDelayMinutes ?? 0}m mean delay`);
    if (item.id === 'station-crowding') output = 'Shared Worker model active · ' + lineText('crowding', (value, line) => `${line} ${value?.score ?? 0}/100`);
    if (item.id === 'headway-bunching') output = 'Shared Worker model active · ' + lineText('headway', (value, line) => `${line} ${value?.risk ?? 0}% ${value?.location || ''}`);
    if (item.id === 'disruption-propagation') output = 'Shared Worker model active · ' + lineText('severity', (value, line) => `${line} ${value || 'on time'}`);
    if (item.id === 'control-room-decisions') output = 'Shared Worker control-room recommendations active';
    return { ...item, status: 'live', output, confidence: Math.max(Number(item.confidence) || 0, 72), source: 'cloudflare-worker-shared-inference' };
  });
};

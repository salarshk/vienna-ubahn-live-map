import React, { useMemo, useState } from 'react';
import { Accessibility, CalendarDays, CloudRain, Database, History, LifeBuoy, RefreshCw, Route, Signpost, ThumbsDown, ThumbsUp, Users } from 'lucide-react';
import {
  PASSENGER_STATIONS,
  buildIncidentSimilarities,
  buildRescueOptions,
  buildRiskAwareJourneys,
  buildStationCrowdingNowcast,
  getPredictionFeedbackSummary,
  recordPredictionFeedback,
} from '../services/passengerIntelligence';
import { lineColor } from '../utils/lineColor';
import { mobilityContextStore } from '../services/mobilityContextStore';
import { buildArrivalByOptions } from '../services/arrivalByPlanner';
import { getLastDirectScheduledSbahnJourney } from '../services/sbahnSchedule';
import { estimatedArrivalByChance, fetchRailHistory, stationDelayWindowsFromHistory } from '../services/sharedRailHistory';
import { fetchBikeHistory, forecastBikeStock } from '../services/bikeAvailability';

const timeLabel = (value) => new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' }).format(value);
const metres = ([aLon, aLat], [bLon, bLat]) => {
  const radians = Math.PI / 180;
  const dLat = (bLat - aLat) * radians;
  const dLon = (bLon - aLon) * radians;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * radians) * Math.cos(bLat * radians) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

const stationNames = PASSENGER_STATIONS.map((station) => station.name);
const EMPTY_CONTEXT = {};
const firstStation = (preferred, fallbackIndex = 0) => stationNames.find((name) => name === preferred) || stationNames[fallbackIndex] || '';

const formatDue = (seconds) => {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '—';
  return value <= 0 ? 'now' : `${Math.ceil(value / 60)} min`;
};

const PassengerIntelligence = ({ now, issues = [], disruptions = [], history = [], reliability = [], vehicles = [], entries = [], mobilitySnapshot = null }) => {
  const [origin, setOrigin] = useState(() => firstStation('Karlsplatz'));
  const [destination, setDestination] = useState(() => firstStation('Schwedenplatz', 1));
  const [includeTrams, setIncludeTrams] = useState(false);
  const [accessibleOnly, setAccessibleOnly] = useState(false);
  const [feedbackModel, setFeedbackModel] = useState('U-Bahn delay');
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const [contextRefreshing, setContextRefreshing] = useState(false);
  const [deadlineTime, setDeadlineTime] = useState(() => new Date(Date.now() + 45 * 60000).toTimeString().slice(0, 5));
  const [originHistoryState, setOriginHistoryState] = useState({ origin: null, data: null });
  const [bikeHistory, setBikeHistory] = useState(null);
  const context = mobilitySnapshot?.context || EMPTY_CONTEXT;
  const sourceStates = mobilitySnapshot?.sources || {};
  const lineRisks = useMemo(() => reliability.map((item) => ({ line: item.line, risk: item.score == null ? 35 : Math.max(0, 100 - item.score) })), [reliability]);
  const blockedStations = useMemo(() => disruptions.filter((item) => item.isElevator && item.station).map((item) => item.station), [disruptions]);
  const journeys = useMemo(() => buildRiskAwareJourneys({ origin, destination, lineRisks, includeTrams, accessibleOnly, blockedStations }), [origin, destination, lineRisks, includeTrams, accessibleOnly, blockedStations]);
  const rescues = useMemo(() => buildRescueOptions({ vehicles, lineRisks, now }), [vehicles, lineRisks, now]);
  const stationCrowding = useMemo(() => buildStationCrowdingNowcast({ entries, issues, now, context }), [entries, issues, now, context]);
  const similarities = useMemo(() => buildIncidentSimilarities({ alerts: disruptions, history }), [disruptions, history]);
  const feedbackSummary = getPredictionFeedbackSummary();
  const platformRows = useMemo(() => entries.flatMap((entry) => (entry.arrivals || []).map((arrival) => ({ ...arrival, stationName: entry.stationName })))
    .filter((arrival) => arrival.isLive && (arrival.platform || arrival.gate))
    .sort((a, b) => a.seconds - b.seconds)
    .filter((arrival, index, all) => all.findIndex((candidate) => candidate.stationName === arrival.stationName && candidate.line === arrival.line && candidate.destination === arrival.destination) === index)
    .slice(0, 6), [entries]);
  React.useEffect(() => {
    let active = true;
    fetchRailHistory({ station: origin, days: 0 }).then((data) => { if (active) setOriginHistoryState({ origin, data }); }).catch(() => {});
    return () => { active = false; };
  }, [origin]);
  const originHistory = originHistoryState.origin === origin ? originHistoryState.data : null;
  const deadlineAt = useMemo(() => {
    const [hour, minute] = deadlineTime.split(':').map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    const date = new Date(now);
    date.setHours(hour, minute, 0, 0);
    if (date.getTime() < now - 60000) date.setDate(date.getDate() + 1);
    return date.getTime();
  }, [deadlineTime, now]);
  const arrivalOptions = useMemo(() => buildArrivalByOptions({ origin, destination, entries, now }), [origin, destination, entries, now]);
  const originLines = PASSENGER_STATIONS.find((station) => station.name === origin)?.lines || [];
  const etaEvidence = stationDelayWindowsFromHistory(originHistory, origin, originLines, now).find((window) => window.id === '60m')?.lines || [];
  const arrivalOutlooks = arrivalOptions.slice(0, 4).map((option) => {
    const evidence = etaEvidence.find((row) => row.line === option.line);
    const outlook = estimatedArrivalByChance({
      departureAt: option.departureAt, travelSeconds: option.travelSeconds, deadlineAt,
      etaPairs: option.scheduled ? 0 : evidence?.etaPairs || 0,
      meanEtaRevisionSeconds: Math.max((option.latestLikelyAt - option.expectedAt) / 2000, evidence?.meanEtaRevisionSeconds || 0),
    });
    return { ...option, outlook };
  });
  const lastDirectSbahn = useMemo(() => getLastDirectScheduledSbahnJourney(origin, destination, now), [origin, destination, now]);
  const nightBackup = lastDirectSbahn && lastDirectSbahn.departureAt - now <= 90 * 60000
    ? arrivalOptions.find((option) => option.line.startsWith('U') && option.expectedAt <= deadlineAt) : null;
  const destinationStation = PASSENGER_STATIONS.find((station) => station.name === destination);
  const nearbyDestinationBikes = destinationStation?.coordinates ? (context.bikeShare?.stations || [])
    .filter((bike) => Number.isFinite(bike.lon) && Number.isFinite(bike.lat))
    .map((bike) => ({ ...bike, metres: Math.round(metres(destinationStation.coordinates, [bike.lon, bike.lat])) }))
    .filter((bike) => bike.metres <= 800).sort((a, b) => a.metres - b.metres).slice(0, 2) : [];
  const bikeIds = nearbyDestinationBikes.map((bike) => bike.id).join(',');
  React.useEffect(() => {
    let active = true;
    if (!bikeIds) return undefined;
    fetchBikeHistory(bikeIds.split(',')).then((data) => { if (active) setBikeHistory(data); }).catch(() => { if (active) setBikeHistory(null); });
    return () => { active = false; };
  }, [bikeIds]);

  const submitFeedback = (outcome) => {
    recordPredictionFeedback({ model: feedbackModel, outcome, context: `live=${vehicles.length}; alerts=${disruptions.length}` });
    setFeedbackSaved(true);
    window.setTimeout(() => setFeedbackSaved(false), 1800);
  };

  const refreshContext = async () => {
    setContextRefreshing(true);
    await mobilityContextStore.refresh({ force: true });
    setContextRefreshing(false);
  };

  const publicSources = Object.values(sourceStates).filter((item) => item.kind === 'public');
  const connectedSources = publicSources.filter((item) => item.status === 'live').length;
  const restrictedSources = Object.values(sourceStates).filter((item) => ['awaiting access', 'unavailable'].includes(item.status));

  return <section className="intelligence-section passenger-intelligence">
    <div className="intelligence-section-title"><Route size={14} /><strong>Passenger intelligence</strong><em>Experimental</em></div>

    <div className="advanced-card external-context-card">
      <div className="advanced-card-title"><strong><Database size={13} /> External data context</strong><span>{connectedSources}/{publicSources.length} public feeds</span></div>
      <div className="context-summary-grid">
        <span><CloudRain size={13} />Weather<strong>{context.weatherNowcast?.next60MinPrecipitation == null ? '—' : `${context.weatherNowcast.next60MinPrecipitation.toFixed(1)} mm/60m`}</strong></span>
        <span><CalendarDays size={13} />Calendar<strong>{context.holidays?.isPublicHoliday ? 'Public holiday' : context.holidays?.isSchoolHoliday ? 'School holiday' : 'Working day'}</strong></span>
        <span>Air monitor<strong>{context.airQuality?.pm10 == null ? (context.airQuality?.stationCount ? `${context.airQuality.stationCount} stations` : '—') : `PM10 ${context.airQuality.pm10}`}</strong></span>
        <span>Bike fallback<strong>{context.bikeShare?.availableBikes == null ? '—' : `${context.bikeShare.availableBikes} bikes`}</strong></span>
      </div>
      <div className="context-source-list">{Object.values(sourceStates).map((source) => <span key={source.id} className={`context-source ${source.status.replace(/\s+/g, '-')}`} title={source.error || source.models}><i />{source.label}</span>)}</div>
      <button className="context-refresh" onClick={refreshContext} disabled={contextRefreshing}><RefreshCw size={13} className={contextRefreshing ? 'spin' : ''} />{contextRefreshing ? 'Refreshing…' : 'Refresh external context'}</button>
      {restrictedSources.length > 0 && <small className="advanced-caveat">Partner-only feeds are represented honestly until a licensed relay is configured; no private endpoint is scraped.</small>}
    </div>

      <div className="advanced-card">
        <div className="advanced-card-title"><strong>Risk-aware journey planner</strong><span>choose the resilient route</span></div>
        <p className="prediction-description">Ranks direct and one-transfer options by current service risk. It does not replace the official timetable’s exact travel time.</p>
        <div className="passenger-selects">
          <label>From<select value={origin} onChange={(event) => setOrigin(event.target.value)}>{stationNames.map((name) => <option key={`from-${name}`}>{name}</option>)}</select></label>
          <label>To<select value={destination} onChange={(event) => setDestination(event.target.value)}>{stationNames.map((name) => <option key={`to-${name}`}>{name}</option>)}</select></label>
        </div>
        <div className="passenger-route-toggles">
          <label><input type="checkbox" checked={includeTrams} onChange={(event) => setIncludeTrams(event.target.checked)} /> Include tram options</label>
          <label><input type="checkbox" checked={accessibleOnly} onChange={(event) => setAccessibleOnly(event.target.checked)} /> <Accessibility size={12} /> Avoid reported lift outages</label>
        </div>
        {journeys.length ? <div className="advanced-list">{journeys.map((journey) => <div className="advanced-row" key={journey.id}>
        <i style={{ background: lineColor(journey.lines[0]) }}>{journey.lines.join('·')}</i>
        <div><strong>{journey.label}</strong><span>{journey.transfer ? `Change at ${journey.transfer}` : journey.evidence}</span></div>
        <b>{journey.resilience}%</b><small>resilience</small>
      </div>)}</div> : <p className="advanced-empty">Choose two different stations served by a selected mode.</p>}
        <small className="advanced-caveat">Risk is based on current reliability and service-pressure signals; accessibility metadata is advisory and exact departures must be verified before leaving.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Arrive by & last connection</strong><span>direct U-Bahn / S-Bahn only</span></div>
      <label className="arrival-deadline">Arrival deadline <input type="time" value={deadlineTime} onChange={(event) => setDeadlineTime(event.target.value)} /></label>
      {arrivalOutlooks.length ? <div className="advanced-list">{arrivalOutlooks.map((option) => <div className="arrival-outlook" key={option.id}>
        <strong><span style={{ color: lineColor(option.line) }}>{option.line}</span> Board {timeLabel(option.departureAt)} → estimated arrival {timeLabel(option.expectedAt)}</strong>
        <span>{option.outlook?.chance == null ? 'Chance still calibrating' : `${option.outlook.chance}% experimental chance by ${deadlineTime}`} · planning range {timeLabel(option.outlook?.lowerAt || option.expectedAt)}–{timeLabel(option.outlook?.upperAt || option.latestLikelyAt)}</span>
        {option.outlook && deadlineAt && <span>{option.departureAt > deadlineAt - option.travelSeconds * 1000 - option.outlook.uncertaintySeconds * 1000 ? 'Tight for this deadline; consider an earlier train.' : `Board by about ${timeLabel(deadlineAt - option.travelSeconds * 1000 - option.outlook.uncertaintySeconds * 1000)} for a planning buffer.`}</span>}
        <small>{option.source}{option.scheduled ? ' · disruption/cancellation not reflected' : ` · ${option.outlook?.evidencePairs || 0} prior ETA comparisons`}</small>
      </div>)}</div> : <p className="advanced-empty">No direct live or scheduled departure is available for this pair. One-transfer routes above have no arrival-time promise.</p>}
      {lastDirectSbahn && <p className="advanced-caveat">Last scheduled direct {lastDirectSbahn.line} towards {lastDirectSbahn.destination} before 04:00: {timeLabel(lastDirectSbahn.departureAt)}. Verify with ÖBB; this timetable does not include live cancellations.</p>}
      {lastDirectSbahn && lastDirectSbahn.departureAt - now <= 90 * 60000 && <p className="advanced-caveat">{nightBackup ? `Nearby backup in current public predictions: direct ${nightBackup.line} at ${timeLabel(nightBackup.departureAt)}. Confirm service before travelling.` : 'No verified direct night backup is visible in the current public feeds; check the official journey planner.'}</p>}
      <small className="advanced-caveat">U-Bahn travel time comes from route geometry and assumed speed. A numeric chance appears only after 30 same-departure ETA comparisons and is not yet validated against physical arrivals. “Board” time is at the origin platform, not a leave-home time. U-Bahn last-service and night-bus protection need a current timetable feed.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Bike after arrival</strong><span>WienMobil Rad · live stock</span></div>
      {nearbyDestinationBikes.length ? nearbyDestinationBikes.map((bike) => {
        const outlook = forecastBikeStock(bikeHistory, bike.id, arrivalOptions[0]?.expectedAt || now + 15 * 60000, now);
        return <div className="arrival-outlook" key={bike.id}><strong>{bike.name} · {bike.metres} m from {destination}</strong><span>{bike.bikes ?? '—'} bikes and {bike.docks ?? '—'} free docks now · {outlook?.expectedBikes == null ? 'arrival trend collecting' : `about ${outlook.expectedBikes} bikes in ${outlook.horizonMinutes} min (trend estimate)`}</span></div>;
      }) : <p className="advanced-empty">No nearby live bike-share station is available for this destination.</p>}
      <small className="advanced-caveat">The trend extrapolates at least four shared GBFS samples over 20 minutes; reservations and sudden rentals are not predicted. Never rely on it as a guaranteed bike.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong><LifeBuoy size={13} /> Missed-connection rescue</strong><span>live fallback options</span></div>
      {rescues.length ? <div className="advanced-list">{rescues.map((item) => <div className="advanced-row" key={item.id}>
        <i style={{ background: lineColor(item.line) }}>{item.line}</i>
        <div><strong>{item.station} → {item.destination}</strong><span>From {item.fromLine} · departs in {formatDue(item.departureSeconds)} · {item.action}</span></div>
        <b className={item.probability < 50 ? 'risk-high' : ''}>{item.probability}%</b><small>catch chance</small>
      </div>)}</div> : <p className="advanced-empty">No fragile live transfer is visible right now.</p>}
      <small className="advanced-caveat">Fallbacks use public departure predictions and estimated transfer margins, not guaranteed platform-to-platform walking time.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong><Signpost size={13} /> Platform & boarding guidance</strong><span>official platform metadata</span></div>
      {platformRows.length ? <div className="advanced-list">{platformRows.map((arrival, index) => <div className="advanced-row" key={`${arrival.stationName}-${arrival.line}-${arrival.destination}-${index}`}>
        <i style={{ background: lineColor(arrival.line) }}>{arrival.line}</i>
        <div><strong>{arrival.stationName} · platform {arrival.platform || arrival.gate}</strong><span>Towards {arrival.destination} · due {formatDue(arrival.seconds)} · {arrival.barrierFree === false ? 'step-free access not reported' : 'accessibility metadata available'}</span></div>
        <b>{arrival.directionCode || '—'}</b><small>direction</small>
      </div>)}</div> : <p className="advanced-empty">No live platform metadata is available in the current cache.</p>}
      <small className="advanced-caveat">Board on the displayed platform and follow local signs. “Direction” and centre-of-train suggestions are guidance, not operator instructions.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong><History size={13} /> Historical incident similarity</strong><span>local archive</span></div>
      {similarities.length ? <div className="advanced-list">{similarities.map((item) => <div className="advanced-row" key={item.alertId}>
        <i>!</i><div><strong>{item.title}</strong><span>{item.status} · {item.matches} similar archived observation{item.matches === 1 ? '' : 's'}</span></div><b>{item.matches}</b><small>matches</small>
      </div>)}</div> : <p className="advanced-empty">No active incident is available for comparison.</p>}
      <small className="advanced-caveat">Matches are calculated from notices previously seen on this device; they are evidence, not a promise of the same recovery time.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong><Users size={13} /> Station crowding nowcast</strong><span>pressure proxy</span></div>
      {stationCrowding.length ? <div className="advanced-list">{stationCrowding.map((item) => <div className="advanced-row" key={item.station}>
        <i className={item.level === 'high' ? 'risk-high' : ''}>{item.lines.slice(0, 2).join('·') || '—'}</i><div><strong>{item.station}</strong><span>{item.evidence}</span></div><b>{item.score}</b><small>{item.level}</small>
      </div>)}</div> : <p className="advanced-empty">Waiting for station departures to estimate pressure.</p>}
      <small className="advanced-caveat">This is a station-level service-pressure estimate, not a passenger counter or occupancy measurement.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Prediction feedback</strong><span>improve future labels</span></div>
      <p className="prediction-description">Tell us whether a prediction was useful after you observe the real outcome. Feedback stays on this device for future model evaluation.</p>
      <div className="feedback-controls"><select value={feedbackModel} onChange={(event) => setFeedbackModel(event.target.value)} aria-label="Prediction model"><option>U-Bahn delay</option><option>Next-station ETA</option><option>Dwell time</option><option>Headway & bunching</option><option>Station crowding</option><option>Route resilience</option><option>Connection rescue</option></select><button onClick={() => submitFeedback('useful')}><ThumbsUp size={13} /> Useful</button><button onClick={() => submitFeedback('inaccurate')}><ThumbsDown size={13} /> Inaccurate</button></div>
      {feedbackSaved && <div className="feed-status live"><ThumbsUp size={13} /> Saved on this device.</div>}
      <div className="quality-grid"><span>Useful<strong>{feedbackSummary[feedbackModel]?.useful || 0}</strong></span><span>Inaccurate<strong>{feedbackSummary[feedbackModel]?.inaccurate || 0}</strong></span></div>
      <small className="advanced-caveat">Feedback is not sent to Wiener Linien or ÖBB and does not change a model immediately.</small>
    </div>
  </section>;
};

export default PassengerIntelligence;

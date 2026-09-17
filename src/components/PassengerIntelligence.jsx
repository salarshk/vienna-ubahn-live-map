import React, { useMemo, useState } from 'react';
import { CalendarDays, CloudRain, Database, History, LifeBuoy, RefreshCw, Route, Signpost, ThumbsDown, ThumbsUp, Users } from 'lucide-react';
import {
  JOURNEY_STATIONS,
  buildIncidentSimilarities,
  buildRescueOptions,
  buildRiskAwareJourneys,
  buildStationCrowdingNowcast,
  getPredictionFeedbackSummary,
  recordPredictionFeedback,
} from '../services/passengerIntelligence';
import { lineColor } from '../utils/lineColor';
import { mobilityContextStore } from '../services/mobilityContextStore';

const stationNames = JOURNEY_STATIONS.map((station) => station.name);
const firstStation = (preferred, fallbackIndex = 0) => stationNames.find((name) => name === preferred) || stationNames[fallbackIndex] || '';

const formatDue = (seconds) => {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '—';
  return value <= 0 ? 'now' : `${Math.ceil(value / 60)} min`;
};

const PassengerIntelligence = ({ now, issues = [], disruptions = [], history = [], reliability = [], vehicles = [], entries = [], mobilitySnapshot = null }) => {
  const [origin, setOrigin] = useState(() => firstStation('Karlsplatz'));
  const [destination, setDestination] = useState(() => firstStation('Schwedenplatz', 1));
  const [feedbackModel, setFeedbackModel] = useState('U-Bahn delay');
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const [contextRefreshing, setContextRefreshing] = useState(false);
  const context = mobilitySnapshot?.context || {};
  const sourceStates = mobilitySnapshot?.sources || {};
  const lineRisks = useMemo(() => reliability.map((item) => ({ line: item.line, risk: item.score == null ? 35 : Math.max(0, 100 - item.score) })), [reliability]);
  const journeys = useMemo(() => buildRiskAwareJourneys({ origin, destination, lineRisks }), [origin, destination, lineRisks]);
  const rescues = useMemo(() => buildRescueOptions({ vehicles, lineRisks, now }), [vehicles, lineRisks, now]);
  const stationCrowding = useMemo(() => buildStationCrowdingNowcast({ entries, issues, now, context }), [entries, issues, now, context]);
  const similarities = useMemo(() => buildIncidentSimilarities({ alerts: disruptions, history }), [disruptions, history]);
  const feedbackSummary = useMemo(() => getPredictionFeedbackSummary(), [feedbackSaved]);
  const platformRows = useMemo(() => entries.flatMap((entry) => (entry.arrivals || []).map((arrival) => ({ ...arrival, stationName: entry.stationName })))
    .filter((arrival) => arrival.isLive && (arrival.platform || arrival.gate))
    .sort((a, b) => a.seconds - b.seconds)
    .filter((arrival, index, all) => all.findIndex((candidate) => candidate.stationName === arrival.stationName && candidate.line === arrival.line && candidate.destination === arrival.destination) === index)
    .slice(0, 6), [entries]);

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
      {journeys.length ? <div className="advanced-list">{journeys.map((journey) => <div className="advanced-row" key={journey.id}>
        <i style={{ background: lineColor(journey.lines[0]) }}>{journey.lines.join('·')}</i>
        <div><strong>{journey.label}</strong><span>{journey.transfer ? `Change at ${journey.transfer}` : journey.evidence}</span></div>
        <b>{journey.resilience}%</b><small>resilience</small>
      </div>)}</div> : <p className="advanced-empty">Choose two different stations served by the U-Bahn.</p>}
      <small className="advanced-caveat">Risk is based on current reliability and service-pressure signals; verify exact departures before leaving.</small>
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

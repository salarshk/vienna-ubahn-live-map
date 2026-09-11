import React, { useMemo } from 'react';
import { Activity, CloudRain, GitBranch, ShieldCheck, Sparkles, TrainFront, Users } from 'lucide-react';
import { lineColor } from '../utils/lineColor';
import {
  calibrateUncertainty, classifyDelaySeverity, detectPredictiveAnomalies,
  forecastCrowding, predictCancellationRisk, predictDelayBands, predictDisruptionResolution,
  predictDwellTimes, predictEventDemand, predictHeadwayRisk,
  predictSbahnConnections, predictTransferSuccess, predictWeatherImpact,
  scoreRouteReliability,
} from '../services/predictionModels';

const PredictionLab = ({ now, issues = [], disruptions = [], crowding = [], reliability = [], vehicles = [], arrivals = [], transfers = [], routeRisk = [], delayPredictions = [], weather = null }) => {
  const dwell = useMemo(() => predictDwellTimes({ vehicles }), [vehicles]);
  const headways = useMemo(() => predictHeadwayRisk({ issues, arrivals }), [issues, arrivals]);
  const resolution = useMemo(() => predictDisruptionResolution({ disruptions, issues, reliability }), [disruptions, issues, reliability]);
  const severity = useMemo(() => classifyDelaySeverity({ arrivals, disruptions }), [arrivals, disruptions]);
  const delayBands = useMemo(() => predictDelayBands({ arrivals, linePredictions: delayPredictions }), [arrivals, delayPredictions]);
  const transfer = useMemo(() => predictTransferSuccess({ transfers }), [transfers]);
  const routes = useMemo(() => scoreRouteReliability({ routeRisk, reliability }), [routeRisk, reliability]);
  const cancellations = useMemo(() => predictCancellationRisk({ arrivals, disruptions, issues }), [arrivals, disruptions, issues]);
  const crowd = useMemo(() => forecastCrowding({ crowding, issues, now }), [crowding, issues, now]);
  const weatherForecast = useMemo(() => predictWeatherImpact({ weather, now }), [weather, now]);
  const events = useMemo(() => predictEventDemand({ alerts: disruptions, now }), [disruptions, now]);
  const sbahn = useMemo(() => predictSbahnConnections({ vehicles, now }), [vehicles, now]);
  const anomalies = useMemo(() => detectPredictiveAnomalies({ vehicles, issues, arrivals }), [vehicles, issues, arrivals]);
  const uncertainty = useMemo(() => calibrateUncertainty({ vehicles, reliability }), [vehicles, reliability]);

  const explain = (text) => <p className="prediction-description">{text}</p>;

  return <section className="intelligence-section prediction-lab">
    <div className="intelligence-section-title"><Sparkles size={14} /><strong>Prediction lab</strong><em>Experimental</em></div>
    <p className="intelligence-note advanced-intro">These models complement the main delay model. They use public timing, inferred positions and notices; where Wiener Linien or ÖBB do not publish a signal, the card says so instead of pretending it is measured.</p>

    <div className="advanced-card"><div className="advanced-card-title"><strong><Activity size={13} /> Dwell-time forecast</strong><span>station stop risk</span></div>
      {explain('Estimates whether a train will remain at a platform longer than its normal stop, which can delay following services.')}
      {dwell.length ? <div className="advanced-list">{dwell.slice(0, 4).map((item) => <div className="advanced-row" key={`${item.line}-${item.station}`}><i style={{ background: lineColor(item.line) }}>{item.line}</i><div><strong>{item.station}</strong><span>{item.evidence}</span></div><b>{item.predictedMinutes}m</b><small>{item.confidence}%</small></div>)}</div> : <p className="advanced-empty">No prolonged live platform stop detected.</p>}
      <small className="advanced-caveat">Predicts dwell from live platform observations; it is not a door or passenger-count sensor.</small>
    </div>

    <div className="advanced-card"><div className="advanced-card-title"><strong><TrainFront size={13} /> Headway & bunching</strong><span>next 20–30 min</span></div>
      {explain('Predicts service gaps and trains running too close together on each U-Bahn line.')}
      <div className="advanced-line-grid">{headways.map((item) => <div key={item.line}>
        <i style={{ background: lineColor(item.line) }}>{item.line}</i>
        <strong className={`risk-label ${item.status === 'high' ? 'high' : item.status === 'watch' ? 'medium' : 'low'}`}>{item.risk}% {item.status}</strong>
        <span>{item.evidence}</span>
        <small className="headway-location">Location: {item.location}</small>
      </div>)}</div>
    </div>

    <div className="advanced-card"><div className="advanced-card-title"><strong><Activity size={13} /> Disruption resolution</strong><span>incident clearance</span></div>
      {explain('Estimates how long an active official service incident may affect passengers before recovery.')}
      <div className="advanced-list">{resolution.slice(0, 4).map((item, index) => <div className="advanced-row" key={`${item.title}-${index}`}><i style={{ background: item.line === 'Network' ? '#777' : lineColor(item.line) }}>{item.line}</i><div><strong>{item.title || item.status}</strong><span>{item.evidence}</span></div><b>{item.window}</b><small>{item.confidence}%</small></div>)}</div>
      <small className="advanced-caveat">A survival-style clearance estimate; an official end time takes precedence.</small>
    </div>

    <div className="advanced-card"><div className="advanced-card-title"><strong>Delay severity classifier</strong><span>line-level category</span></div>
      {explain('Turns reported delay minutes and notices into on-time, minor, major or severe categories.')}
      <div className="advanced-line-grid">{severity.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong className={`risk-label ${item.category === 'severe' || item.category === 'major' ? 'high' : item.category === 'minor' ? 'medium' : 'low'}`}>{item.category}</strong><span>{item.meanMinutes}m mean · {item.samples} reports</span></div>)}</div>
    </div>

    <div className="advanced-card"><div className="advanced-card-title"><strong>Probabilistic delay bands</strong><span>next 15 min</span></div>
      {explain('Shows a typical delay and a high-delay boundary, so a route is not represented by one falsely precise number.')}
      <div className="advanced-line-grid">{delayBands.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong>{item.low.toFixed(1)}–{item.high.toFixed(1)} min</strong><span>typical {item.typical.toFixed(1)}m · {item.confidence}% confidence</span><small>{item.evidence}</small></div>)}</div>
      <small className="advanced-caveat">Bands combine current operator-reported delay observations with the published model when it is available.</small>
    </div>

    <div className="advanced-card"><div className="advanced-card-title"><strong>Transfer success probability</strong><span>connection margin</span></div>
      {explain('Estimates the chance of catching a connecting train from the predicted arrival and departure margin.')}
      {transfer.length ? <div className="advanced-list">{transfer.slice(0, 4).map((item) => <div className="advanced-row" key={`${item.from}-${item.to}-${item.station}`}><i style={{ background: lineColor(item.from) }}>{item.from}</i><div><strong>{item.station} → {item.to}</strong><span>{item.destination}</span></div><b>{item.probability}%</b><small>{item.rating}</small></div>)}</div> : <p className="advanced-empty">No live connection margin available.</p>}
    </div>

    <div className="advanced-card"><div className="advanced-card-title"><strong><GitBranch size={13} /> Route reliability</strong><span>risk-adjusted score</span></div>
      {explain('Ranks lines by expected reliability and points to a lower-risk alternative when one is visible.')}
      <div className="advanced-line-grid">{routes.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong className={`risk-label ${item.score < 50 ? 'high' : item.score < 70 ? 'medium' : 'low'}`}>{item.score}/100</strong><span>{item.alternative ? `Alternative ${item.alternative}` : item.evidence}</span></div>)}</div>
    </div>

    <div className="advanced-card"><div className="advanced-card-title"><strong>Cancellation & short-turn risk</strong><span>service continuity</span></div>
      {explain('Flags lines where gaps, incidents or missing live departures suggest a cancelled or short-turned service.')}
      <div className="advanced-line-grid">{cancellations.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong className={`risk-label ${item.status === 'high' ? 'high' : item.status === 'watch' ? 'medium' : 'low'}`}>{item.risk}% {item.status}</strong><span>{item.action}</span></div>)}</div>
    </div>

    <div className="advanced-card"><div className="advanced-card-title"><strong><Users size={13} /> Crowding forecast</strong><span>service-pressure proxy</span></div>
      {explain('Estimates passenger-pressure risk from peak hours, service gaps and bunching; it is not a passenger counter.')}
      <div className="advanced-line-grid">{crowd.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong className={`risk-label ${item.level === 'high' ? 'high' : item.level === 'medium' ? 'medium' : 'low'}`}>{item.score}/100</strong><span>{item.level} · {item.window}</span></div>)}</div>
    </div>

    <div className="advanced-card"><div className="advanced-card-title"><strong><CloudRain size={13} /> Weather impact</strong><span>external feed</span></div>
      {explain('Would estimate additional disruption risk from rain, snow, wind and other weather conditions when a feed is connected.')}
      <div className="quality-grid"><span>Status<strong>{weatherForecast.status}</strong></span><span>Impact<strong>{weatherForecast.impact ?? '—'}</strong></span><span>Confidence<strong>{weatherForecast.confidence}%</strong></span><span>Horizon<strong>{weatherForecast.horizon}</strong></span></div>
      <small className="advanced-caveat">{weather?.description ? `${weather.description} in Vienna · ${weather.source}.` : 'Waiting for the keyless Vienna weather context feed.'}</small>
    </div>

    <div className="advanced-card"><div className="advanced-card-title"><strong>Event-demand forecast</strong><span>calendar signal</span></div>
      {explain('Extracts event-like demand signals from official service/news text, then falls back to weekday and peak-hour baselines.')}
      <div className="quality-grid"><span>State<strong>{events.status}</strong></span><span>Pressure<strong>{events.score}/100</strong></span><span>Confidence<strong>{events.confidence}%</strong></span><span>Evidence<strong>{events.evidence}</strong></span></div>
    </div>

    <div className="advanced-card"><div className="advanced-card-title"><strong>S-Bahn connection forecast</strong><span>ÖBB timetable only</span></div>
      {explain('Shows upcoming S-Bahn timetable connections and their expected timing, without claiming live delay information.')}
      {sbahn.length ? <div className="advanced-list">{sbahn.slice(0, 4).map((item, index) => <div className="advanced-row" key={`${item.line}-${item.station}-${index}`}><i style={{ background: '#777' }}>{item.line}</i><div><strong>{item.station}</strong><span>{item.destination || 'scheduled service'}</span></div><b>{item.minutes}m</b><small>schedule</small></div>)}</div> : <p className="advanced-empty">No active S-Bahn timetable movement.</p>}
      <small className="advanced-caveat">Live S-Bahn delay and vehicle GPS are not published in the current feed, so this cannot claim actual delay.</small>
    </div>

    <div className="advanced-card"><div className="advanced-card-title"><strong>Predictive anomaly detection</strong><span>early warning</span></div>
      {explain('Searches for unusual gaps, bunching, missing feeds or low-confidence train positions that may need attention.')}
      {anomalies.length ? <ul className="advanced-evidence-list">{anomalies.slice(0, 6).map((item, index) => <li key={`${item.type}-${item.line}-${index}`}><strong>{item.line} · {item.type}</strong><span>{item.detail}</span><small>{item.severity}</small></li>)}</ul> : <p className="advanced-empty">No unusual pattern detected.</p>}
    </div>

    <div className="advanced-card"><div className="advanced-card-title"><strong><ShieldCheck size={13} /> Uncertainty calibration</strong><span>confidence intervals</span></div>
      {explain('Widens or narrows confidence intervals according to feed freshness, position uncertainty and available history.')}
      <div className="advanced-line-grid">{uncertainty.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong>{item.intervalMinutes}m interval</strong><span>{item.calibration}% · {item.status}</span></div>)}</div>
      <small className="advanced-caveat">The interval widens when inferred positions are stale or uncertain; it is calibrated from observable feed quality, not GPS truth.</small>
    </div>
  </section>;
};

export default PredictionLab;

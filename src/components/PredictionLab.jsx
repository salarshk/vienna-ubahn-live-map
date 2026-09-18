import React, { useMemo } from 'react';
import { Activity, CloudRain, GitBranch, ShieldCheck, Sparkles, TrainFront, Users } from 'lucide-react';
import { lineColor } from '../utils/lineColor';
import {
  calibrateUncertainty, classifyDelaySeverity, detectPredictiveAnomalies,
  forecastCrowding, predictCancellationRisk, predictDelayBands,
  predictDisruptionImpact, predictDwellForecast, predictEventDemand, predictHeadwayForecast,
  predictMultiHorizonDelay, predictNextStationEta, predictRecoveryForecast,
  predictSbahnConnections, predictTransferSuccess, predictWeatherImpact,
  scoreRouteReliability,
} from '../services/predictionModels';
import { buildDataDrivenModels } from '../services/dataDrivenModels';
import { buildTramPredictions } from '../services/tramIntelligence';
import {
  buildMultimodalFallbacks,
  estimateEnvironmentalComfort,
  predictAirportArrivalWave,
  predictEventCrowding,
  predictTrafficAwareTrams,
} from '../services/transportIntelligence';

const PredictionLab = ({ now, issues = [], disruptions = [], crowding = [], reliability = [], vehicles = [], arrivals = [], transfers = [], routeRisk = [], delayPredictions = [], weather = null, mobilitySnapshot = null, networkSnapshot = null, operationalModels = null, category = 'all' }) => {
  const shared = networkSnapshot?.data?.models?.predictionLab;
  const multiHorizon = useMemo(() => shared?.multiHorizon || predictMultiHorizonDelay({ arrivals, linePredictions: delayPredictions, disruptions, now }), [shared, arrivals, delayPredictions, disruptions, now]);
  const eta = useMemo(() => shared?.eta || predictNextStationEta({ vehicles }), [shared, vehicles]);
  const dwell = useMemo(() => shared?.dwell || predictDwellForecast({ vehicles }), [shared, vehicles]);
  const headways = useMemo(() => shared?.headways || predictHeadwayForecast({ issues, arrivals }), [shared, issues, arrivals]);
  const recovery = useMemo(() => shared?.recovery || predictRecoveryForecast({ disruptions, issues, reliability }), [shared, disruptions, issues, reliability]);
  const impact = useMemo(() => shared?.impact || predictDisruptionImpact({ disruptions, arrivals, issues, now }), [shared, disruptions, arrivals, issues, now]);
  const severity = useMemo(() => shared?.severity || classifyDelaySeverity({ arrivals, disruptions }), [shared, arrivals, disruptions]);
  const delayBands = useMemo(() => shared?.delayBands || predictDelayBands({ arrivals, linePredictions: delayPredictions }), [shared, arrivals, delayPredictions]);
  const transfer = useMemo(() => shared?.transfers || predictTransferSuccess({ transfers }), [shared, transfers]);
  const routes = useMemo(() => shared?.routes || scoreRouteReliability({ routeRisk, reliability }), [shared, routeRisk, reliability]);
  const cancellations = useMemo(() => shared?.cancellations || predictCancellationRisk({ arrivals, disruptions, issues }), [shared, arrivals, disruptions, issues]);
  const crowd = useMemo(() => shared?.crowd || forecastCrowding({ crowding, issues, now }), [shared, crowding, issues, now]);
  const weatherForecast = useMemo(() => shared?.weather || predictWeatherImpact({ weather, now }), [shared, weather, now]);
  const events = useMemo(() => shared?.events || predictEventDemand({ alerts: disruptions, now }), [shared, disruptions, now]);
  const sbahn = useMemo(() => shared?.sbahn || predictSbahnConnections({ vehicles, now }), [shared, vehicles, now]);
  const anomalies = useMemo(() => shared?.anomalies || detectPredictiveAnomalies({ vehicles, issues, arrivals }), [shared, vehicles, issues, arrivals]);
  const uncertainty = useMemo(() => shared?.uncertainty || calibrateUncertainty({ vehicles, reliability }), [shared, vehicles, reliability]);
  const tramPredictions = useMemo(() => buildTramPredictions({ arrivals, vehicles, issues, disruptions, now }), [arrivals, vehicles, issues, disruptions, now]);
  const transportContext = useMemo(() => mobilitySnapshot?.context || {}, [mobilitySnapshot?.context]);
  const trafficTrams = useMemo(() => predictTrafficAwareTrams({ tramPredictions, context: transportContext, issues, now }), [tramPredictions, transportContext, issues, now]);
  const airportWave = useMemo(() => predictAirportArrivalWave({ context: transportContext, now }), [transportContext, now]);
  const eventCrowding = useMemo(() => predictEventCrowding({ context: transportContext, disruptions, now }), [transportContext, disruptions, now]);
  const environmental = useMemo(() => estimateEnvironmentalComfort({ context: transportContext, now }), [transportContext, now]);
  const fallbacks = useMemo(() => buildMultimodalFallbacks({ context: transportContext, lineRisk: disruptions.length * 20 + issues.length * 8, disruptions, now }), [transportContext, disruptions, issues, now]);
  const dataDrivenModels = useMemo(() => buildDataDrivenModels({
    context: mobilitySnapshot?.context || {},
    sources: mobilitySnapshot?.sources || {},
    arrivals,
    issues,
    disruptions,
    crowding,
    vehicles,
    reliability,
    now,
    remoteModels: networkSnapshot?.data?.models,
  }), [mobilitySnapshot, networkSnapshot, arrivals, issues, disruptions, crowding, vehicles, reliability, now]);

  const explain = (text) => <p className="prediction-description">{text}</p>;
  const show = (name) => category === 'all' || category === name;
  const categoryLabel = { models: 'Models', predictions: 'Live predictions', operations: 'Operations', context: 'Context & diagnostics' }[category];

  return <section className="intelligence-section prediction-lab">
    <div className="intelligence-section-title"><Sparkles size={14} /><strong>Prediction lab{categoryLabel ? ` · ${categoryLabel}` : ''}</strong><em>Experimental</em></div>
    <p className="intelligence-note advanced-intro">These models complement the main delay model. They use public timing, inferred positions and notices; where Wiener Linien or ÖBB do not publish a signal, the card says so instead of pretending it is measured.</p>

    {show('models') && operationalModels && <div className="advanced-card model-registry-card"><div className="advanced-card-title"><strong>Training registry</strong><span>{operationalModels.summary?.candidate || 0} candidates · {operationalModels.summary?.collectingLabels || 0} collecting</span></div>
      {explain('This report distinguishes models with trainable labels from transparent baselines. A candidate is not promoted to live use until it passes a chronological holdout against the operator estimate.')}
      <div className="quality-grid"><span>Observations<strong>{operationalModels.data?.observationRows || 0}</strong></span><span>Delay labels<strong>{operationalModels.data?.labelledDelayRows || 0}</strong></span><span>Headway events<strong>{operationalModels.data?.headwayEvents || 0}</strong></span><span>Calendar days<strong>{operationalModels.data?.calendarDays || 0}</strong></span></div>
      <div className="advanced-evidence-list">{(operationalModels.models || []).map((item) => <div key={item.id} className="model-registry-row"><strong>{item.name}</strong><span>{item.algorithm} · {item.trainingExamples} examples</span><small className={`model-registry-status ${item.status}`}>{item.status === 'candidate' ? 'candidate' : item.status === 'blocked' ? 'blocked' : 'collecting labels'}</small>{item.blocker && <em>{item.blocker}</em>}</div>)}</div>
    </div>}

    {show('models') && <div className="advanced-card data-models-card">
      <div className="advanced-card-title"><strong>New-data model suite</strong><span>{dataDrivenModels.filter((item) => item.status === 'live').length}/{dataDrivenModels.length} live inputs</span></div>
      {explain('These models use the newly connected weather, calendar, air-quality, bike-share and optional partner data. A transparent baseline is shown while labels are collected; a live status means the named feed is currently connected.')}
      {networkSnapshot?.data?.generatedAt && <div className="shared-model-status">Shared Worker inference · updated {new Date(networkSnapshot.data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>}
      <div className="data-model-grid">{dataDrivenModels.map((item) => <article className="data-model-tile" key={item.id}>
        <div className="data-model-tile-head"><strong>{item.name}</strong><span className={`data-model-status ${item.status}`}>{item.status}</span></div>
        <p>{item.description}</p>
        <div className="data-model-output">{item.output}</div>
        <small>{item.inputs} · confidence {item.confidence}%</small>
        {item.id === 'control-room-decisions' && <div className="data-model-decisions">{item.decisions?.map((decision) => <span key={decision.line}><i style={{ background: lineColor(decision.line) }}>{decision.line}</i>{decision.action}</span>)}</div>}
      </article>)}</div>
      <small className="advanced-caveat">Partner-only models stay explicitly labelled as baselines until licensed data is connected. No model claims private GPS, passenger counts or operator telemetry.</small>
    </div>}

    {show('predictions') && <div className="advanced-card"><div className="advanced-card-title"><strong>Multi-horizon delay model</strong><span>2–15 min ahead</span></div>
      {explain('Forecasts each U-Bahn line at several time horizons from current official delay observations, the published line estimate and active incidents.')}
      <div className="advanced-line-grid">{multiHorizon.map((item) => {
        const near = item.forecasts[0];
        const far = item.forecasts.at(-1);
        return <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong>{near.minutes}m → {far.minutes}m</strong><span>2–15 min · {item.confidence}% confidence</span><small>{item.samples} observations · {item.trainingStatus}</small></div>;
      })}</div>
      <small className="advanced-caveat">The current implementation is a calibrated baseline; a dedicated multi-horizon learner will be promoted only after enough labelled history.</small>
    </div>}

    {show('predictions') && <div className="advanced-card"><div className="advanced-card-title"><strong>Next-station ETA model</strong><span>per live train</span></div>
      {explain('Predicts arrival at the next station and provides a range widened by inferred-position uncertainty and observation age.')}
      {eta.length ? <div className="advanced-list">{eta.slice(0, 5).map((item) => <div className="advanced-row" key={item.id}><i style={{ background: lineColor(item.line) }}>{item.line}</i><div><strong>{item.station}</strong><span>{item.destination} · {item.evidence}</span></div><b>{item.etaMinutes}m</b><small>{item.lowMinutes}–{item.highMinutes}m</small></div>)}</div> : <p className="advanced-empty">No live train ETA is available.</p>}
      <small className="advanced-caveat">ETA uses official station departures and inferred position; it is not GPS ground truth.</small>
    </div>}

    {show('predictions') && <div className="advanced-card tram-model-card">
      <div className="advanced-card-title"><strong><TrainFront size={13} /> Tram operations models</strong><span>street-running services</span></div>
      {explain('Separately estimates tram pressure, disruption impact and headway risk because trams share streets and traffic signals. A tram location is still departure-based unless the official feed supplies coordinates.')}
      <div className="advanced-line-grid">{tramPredictions.filter((item) => item.liveArrivals || item.impact > 0 || item.pressure >= 45).slice(0, 12).map((item) => <div key={item.line}>
        <i style={{ background: lineColor(item.line) }}>{item.line}</i>
        <strong>{item.pressureLevel} · {item.impactLevel}</strong>
        <span>{item.meanDelayMinutes > 0 ? `+${item.meanDelayMinutes}m delay` : 'no reported delay'} · {item.confidence}%</span>
        <small>{item.headway.largestGapStation ? `largest gap near ${item.headway.largestGapStation}` : item.evidence}</small>
      </div>)}</div>
      {!tramPredictions.some((item) => item.liveArrivals || item.impact > 0 || item.pressure >= 45) && <p className="advanced-empty">Waiting for live tram observations.</p>}
      <small className="advanced-caveat">This is a transparent tram baseline, not a traffic-signal or operator-control command.</small>
    </div>}

    {show('operations') && <div className="advanced-card">
      <div className="advanced-card-title"><strong><Activity size={13} /> Traffic-aware tram delay</strong><span>road pressure → tram risk</span></div>
      {explain('Combines optional Vienna road observations with live tram pressure. It estimates additional delay exposure; it does not claim a measured traffic signal or exact road speed for each line.')}
      {trafficTrams.some((item) => item.traffic.observations || item.risk > 25) ? <div className="advanced-line-grid">{trafficTrams.filter((item) => item.traffic.observations || item.risk > 25).slice(0, 10).map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong className={`risk-label ${item.level === 'high' ? 'high' : item.level === 'watch' ? 'medium' : 'low'}`}>{item.level} · +{item.extraMinutes}m</strong><span>{item.traffic.congestionScore}/100 road pressure · {item.confidence}%</span><small>{item.evidence}</small></div>)}</div> : <p className="advanced-empty">Waiting for an EVIS or Vienna traffic-counter feed.</p>}
      <small className="advanced-caveat">Road congestion is a context signal for street-running trams, not a verified cause of every delay.</small>
    </div>}

    {show('operations') && <div className="advanced-card">
      <div className="advanced-card-title"><strong>Multimodal fallback engine</strong><span>disruption rescue</span></div>
      {explain('Ranks rail, bike, taxi-stand and walking alternatives when current rail risk rises. Private Uber or taxi vehicle locations are not assumed without a licensed feed.')}
      <div className="advanced-list">{fallbacks.slice(0, 4).map((item) => <div className="advanced-row" key={item.mode}><i>{item.rank}</i><div><strong>{item.title}</strong><span>{item.detail}</span></div><b>{Math.round(item.score)}</b><small>{item.evidence}</small></div>)}</div>
      <small className="advanced-caveat">Fallback scores are relative priorities, not guaranteed travel times or booking availability.</small>
    </div>}

    {show('predictions') && <div className="advanced-card"><div className="advanced-card-title"><strong><Activity size={13} /> Dwell-time model</strong><span>station stop risk</span></div>
      {explain('Estimates whether a train will remain at a platform longer than its normal stop, which can delay following services.')}
      {dwell.length ? <div className="advanced-list">{dwell.slice(0, 4).map((item) => <div className="advanced-row" key={`${item.line}-${item.station}`}><i style={{ background: lineColor(item.line) }}>{item.line}</i><div><strong>{item.station}</strong><span>{item.evidence}</span></div><b>{item.predictedMinutes}m</b><small>{item.confidence}%</small></div>)}</div> : <p className="advanced-empty">No prolonged live platform stop detected.</p>}
      <small className="advanced-caveat">Predicts dwell from live platform observations; it is not a door or passenger-count sensor.</small>
    </div>}

    {show('predictions') && <div className="advanced-card"><div className="advanced-card-title"><strong><TrainFront size={13} /> Headway & bunching model</strong><span>next 20–30 min</span></div>
      {explain('Predicts service gaps and trains running too close together on each U-Bahn line.')}
      <div className="advanced-line-grid">{headways.map((item) => <div key={item.line}>
        <i style={{ background: lineColor(item.line) }}>{item.line}</i>
        <strong className={`risk-label ${item.status === 'high' ? 'high' : item.status === 'watch' ? 'medium' : 'low'}`}>{item.risk}% {item.status}</strong>
        <span>{item.evidence}</span>
        <small className="headway-location">Location: {item.location}</small>
      </div>)}</div>
    </div>}

    {show('operations') && <div className="advanced-card"><div className="advanced-card-title"><strong><Activity size={13} /> Recovery-duration model</strong><span>incident clearance</span></div>
      {explain('Estimates how long an active official service incident may affect passengers before recovery.')}
      <div className="advanced-list">{recovery.slice(0, 4).map((item, index) => <div className="advanced-row" key={`${item.title}-${index}`}><i style={{ background: item.line === 'Network' ? '#777' : lineColor(item.line) }}>{item.line}</i><div><strong>{item.title || item.status}</strong><span>{item.evidence}</span></div><b>{item.window}</b><small>{item.confidence}%</small></div>)}</div>
      <small className="advanced-caveat">A survival-style clearance estimate; an official end time takes precedence.</small>
    </div>}

    {show('operations') && <div className="advanced-card"><div className="advanced-card-title"><strong>Disruption-impact model</strong><span>affected service</span></div>
      {explain('Estimates the delay impact of each official notice by joining its affected lines with current delay and headway evidence.')}
      {impact.length ? <div className="advanced-list">{impact.slice(0, 5).map((item) => <div className="advanced-row" key={item.id}><i style={{ background: item.level === 'high' ? '#ff6b6b' : item.level === 'medium' ? '#ffb74d' : '#4caf50' }}>!</i><div><strong>{item.title}</strong><span>{item.lines.join(' · ') || 'Network'} · {item.affectedStations.join(', ') || 'station not specified'}</span></div><b>+{item.impactMinutes}m</b><small>{item.confidence}%</small></div>)}</div> : <p className="advanced-empty">No active official disruption to model.</p>}
      <small className="advanced-caveat">This is an impact estimate, not an official incident end time.</small>
    </div>}

    {show('predictions') && <div className="advanced-card"><div className="advanced-card-title"><strong>Delay severity classifier</strong><span>line-level category</span></div>
      {explain('Turns reported delay minutes and notices into on-time, minor, major or severe categories.')}
      <div className="advanced-line-grid">{severity.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong className={`risk-label ${item.category === 'severe' || item.category === 'major' ? 'high' : item.category === 'minor' ? 'medium' : 'low'}`}>{item.category}</strong><span>{item.meanMinutes}m mean · {item.samples} reports</span></div>)}</div>
    </div>}

    {show('predictions') && <div className="advanced-card"><div className="advanced-card-title"><strong>Probabilistic delay bands</strong><span>next 15 min</span></div>
      {explain('Shows a typical delay and a high-delay boundary, so a route is not represented by one falsely precise number.')}
      <div className="advanced-line-grid">{delayBands.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong>{item.low.toFixed(1)}–{item.high.toFixed(1)} min</strong><span>typical {item.typical.toFixed(1)}m · {item.confidence}% confidence</span><small>{item.evidence}</small></div>)}</div>
      <small className="advanced-caveat">Bands combine current operator-reported delay observations with the published model when it is available.</small>
    </div>}

    {show('operations') && <div className="advanced-card"><div className="advanced-card-title"><strong>Transfer success probability</strong><span>connection margin</span></div>
      {explain('Estimates the chance of catching a connecting train from the predicted arrival and departure margin.')}
      {transfer.length ? <div className="advanced-list">{transfer.slice(0, 4).map((item) => <div className="advanced-row" key={`${item.from}-${item.to}-${item.station}`}><i style={{ background: lineColor(item.from) }}>{item.from}</i><div><strong>{item.station} → {item.to}</strong><span>{item.destination}</span></div><b>{item.probability}%</b><small>{item.rating}</small></div>)}</div> : <p className="advanced-empty">No live connection margin available.</p>}
    </div>}

    {show('operations') && <div className="advanced-card"><div className="advanced-card-title"><strong><GitBranch size={13} /> Route reliability</strong><span>risk-adjusted score</span></div>
      {explain('Ranks lines by expected reliability and points to a lower-risk alternative when one is visible.')}
      <div className="advanced-line-grid">{routes.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong className={`risk-label ${item.score < 50 ? 'high' : item.score < 70 ? 'medium' : 'low'}`}>{item.score}/100</strong><span>{item.alternative ? `Alternative ${item.alternative}` : item.evidence}</span></div>)}</div>
    </div>}

    {show('operations') && <div className="advanced-card"><div className="advanced-card-title"><strong>Cancellation & short-turn risk</strong><span>service continuity</span></div>
      {explain('Flags lines where gaps, incidents or missing live departures suggest a cancelled or short-turned service.')}
      <div className="advanced-line-grid">{cancellations.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong className={`risk-label ${item.status === 'high' ? 'high' : item.status === 'watch' ? 'medium' : 'low'}`}>{item.risk}% {item.status}</strong><span>{item.action}</span></div>)}</div>
    </div>}

    {show('operations') && <div className="advanced-card"><div className="advanced-card-title"><strong><Users size={13} /> Crowding forecast</strong><span>service-pressure proxy</span></div>
      {explain('Estimates passenger-pressure risk from peak hours, service gaps and bunching; it is not a passenger counter.')}
      <div className="advanced-line-grid">{crowd.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong className={`risk-label ${item.level === 'high' ? 'high' : item.level === 'medium' ? 'medium' : 'low'}`}>{item.score}/100</strong><span>{item.level} · {item.window}</span></div>)}</div>
    </div>}

    {show('context') && <div className="advanced-card"><div className="advanced-card-title"><strong><CloudRain size={13} /> Weather impact</strong><span>external feed</span></div>
      {explain('Would estimate additional disruption risk from rain, snow, wind and other weather conditions when a feed is connected.')}
      <div className="quality-grid"><span>Status<strong>{weatherForecast.status}</strong></span><span>Impact<strong>{weatherForecast.impact ?? '—'}</strong></span><span>Confidence<strong>{weatherForecast.confidence}%</strong></span><span>Horizon<strong>{weatherForecast.horizon}</strong></span></div>
      <small className="advanced-caveat">{weather?.description ? `${weather.description} in Vienna · ${weather.source}.` : 'Waiting for the keyless Vienna weather context feed.'}</small>
    </div>}

    {show('context') && <div className="advanced-card"><div className="advanced-card-title"><strong>Event-demand forecast</strong><span>calendar signal</span></div>
      {explain('Extracts event-like demand signals from official service/news text, then falls back to weekday and peak-hour baselines.')}
      <div className="quality-grid"><span>State<strong>{events.status}</strong></span><span>Pressure<strong>{events.score}/100</strong></span><span>Confidence<strong>{events.confidence}%</strong></span><span>Evidence<strong>{events.evidence}</strong></span></div>
    </div>}

    {show('context') && <div className="advanced-card"><div className="advanced-card-title"><strong>Event crowd forecast</strong><span>station pressure ahead</span></div>
      {explain('Uses an optional Vienna event feed plus peak periods and current disruptions to estimate crowd pressure before it appears in departure data.')}
      <div className="quality-grid"><span>Level<strong>{eventCrowding.level}</strong></span><span>Pressure<strong>{eventCrowding.score}/100</strong></span><span>Events<strong>{eventCrowding.events}</strong></span><span>Confidence<strong>{eventCrowding.confidence}%</strong></span></div>
      <small className="advanced-caveat">Venue-to-station matching is not claimed until event locations are geocoded; this remains a city-level pressure proxy.</small>
    </div>}

    {show('context') && <div className="advanced-card"><div className="advanced-card-title"><strong>Airport arrival-wave pressure</strong><span>S7 · CAT · taxi corridors</span></div>
      {explain('Uses an optional airport-arrivals or OpenSky activity feed to estimate pressure on the airport corridor. Aircraft activity alone cannot confirm flight status, cancellations or passenger counts.')}
      <div className="quality-grid"><span>Level<strong>{airportWave.railPressureLevel}</strong></span><span>Rail pressure<strong>{airportWave.railPressureScore}/100</strong></span><span>Activity<strong>{airportWave.activity}</strong></span><span>Confidence<strong>{airportWave.confidence}%</strong></span></div>
      <small className="advanced-caveat">{airportWave.evidence} · likely corridors: {airportWave.corridors.join(' · ')}</small>
    </div>}

    {show('context') && <div className="advanced-card"><div className="advanced-card-title"><strong>Environmental transfer comfort</strong><span>weather + air quality</span></div>
      {explain('Scores the comfort of outdoor walking and waiting around a transfer using rain, wind, temperature and pollutant observations.')}
      <div className="quality-grid"><span>Level<strong>{environmental.level}</strong></span><span>Comfort<strong>{environmental.score}/100</strong></span><span>Air<strong>PM10 {environmental.pm10 || '—'} · NO₂ {environmental.no2 || '—'}</strong></span><span>Weather<strong>{environmental.rain.toFixed(1)} mm · wind {environmental.wind.toFixed(1)}</strong></span></div>
      <small className="advanced-caveat">{environmental.recommendation}. This is a comfort signal, not medical advice or an official air-quality warning.</small>
    </div>}

    {show('context') && <div className="advanced-card"><div className="advanced-card-title"><strong>S-Bahn connection forecast</strong><span>ÖBB timetable only</span></div>
      {explain('Shows upcoming S-Bahn timetable connections and their expected timing, without claiming live delay information.')}
      {sbahn.length ? <div className="advanced-list">{sbahn.slice(0, 4).map((item, index) => <div className="advanced-row" key={`${item.line}-${item.station}-${index}`}><i style={{ background: '#777' }}>{item.line}</i><div><strong>{item.station}</strong><span>{item.destination || 'scheduled service'}</span></div><b>{item.minutes}m</b><small>schedule</small></div>)}</div> : <p className="advanced-empty">No active S-Bahn timetable movement.</p>}
      <small className="advanced-caveat">Live S-Bahn delay and vehicle GPS are not published in the current feed, so this cannot claim actual delay.</small>
    </div>}

    {show('context') && <div className="advanced-card"><div className="advanced-card-title"><strong>Predictive anomaly detection</strong><span>early warning</span></div>
      {explain('Searches for unusual gaps, bunching, missing feeds or low-confidence train positions that may need attention.')}
      {anomalies.length ? <ul className="advanced-evidence-list">{anomalies.slice(0, 6).map((item, index) => <li key={`${item.type}-${item.line}-${index}`}><strong>{item.line} · {item.type}</strong><span>{item.detail}</span><small>{item.severity}</small></li>)}</ul> : <p className="advanced-empty">No unusual pattern detected.</p>}
    </div>}

    {show('context') && <div className="advanced-card"><div className="advanced-card-title"><strong><ShieldCheck size={13} /> Uncertainty calibration</strong><span>confidence intervals</span></div>
      {explain('Widens or narrows confidence intervals according to feed freshness, position uncertainty and available history.')}
      <div className="advanced-line-grid">{uncertainty.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong>{item.intervalMinutes}m interval</strong><span>{item.calibration}% · {item.status}</span></div>)}</div>
      <small className="advanced-caveat">The interval widens when inferred positions are stale or uncertain; it is calibrated from observable feed quality, not GPS truth.</small>
    </div>}
  </section>;
};

export default PredictionLab;

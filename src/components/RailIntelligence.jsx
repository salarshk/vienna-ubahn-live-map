import React, { useEffect, useMemo, useState } from 'react';
import { Accessibility, Activity, AlertTriangle, Bot, Clock3, Database, Gauge, History, Radar, Sparkles, X } from 'lucide-react';
import { lineColor } from '../utils/lineColor';
import {
  analyseAccessibility,
  estimateCrowdingRisk,
  explainLine,
  forecastDelayPropagation,
  LINES,
} from '../services/transitModels';
import OnboardPilot from './OnboardPilot';
import arrivalStore from '../services/arrivalStore';
import delayModelStore, {
  incidentContextForLine, predictFinalDelay, predictOnlineDelay,
} from '../services/delayModel';
import RailAdvisor from './RailAdvisor';
import AdvancedSignals from './AdvancedSignals';
import trainPositionEngine from '../services/trainPositionEngine';
import { summariseOfficialSnapshot } from '../services/officialSnapshotStore';
import { getReports, subscribe as subscribeReports } from '../services/communityReports';
import OperationsDashboard from './OperationsDashboard';
import DelayTimeline from './DelayTimeline';

const ageLabel = (timestamp) => {
  if (!timestamp) return 'now';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(new Date(timestamp));
};

const RailIntelligence = ({
  snapshot, disruptions = [], replayOffset, replaySnapshot, onReplayChange,
  atlasVisible, onToggleAtlas, onClose, officialSnapshotState, officialReplaySnapshot,
}) => {
  const now = snapshot.generatedAt || 0;
  const [tab, setTab] = useState('forecast');
  const [explainLineId, setExplainLineId] = useState('U1');
  const [delaySnapshot, setDelaySnapshot] = useState(delayModelStore.getSnapshot());
  const [reports, setReports] = useState(() => getReports(now));
  const oldestMinutes = snapshot.replay.first
    ? Math.min(60, Math.floor((now - snapshot.replay.first) / 60000)) : 0;
  const officialOldestMinutes = Math.max(0, Number(officialSnapshotState?.oldestMinutes) || 0);
  const replayMaxMinutes = Math.max(oldestMinutes, officialOldestMinutes);
  const officialSummary = officialReplaySnapshot ? summariseOfficialSnapshot(officialReplaySnapshot) : null;
  const issues = snapshot.issues || [];
  const forecasts = forecastDelayPropagation(issues, disruptions);
  const crowding = estimateCrowdingRisk(issues, new Date(now));
  const accessibility = analyseAccessibility(disruptions);
  const explanation = explainLine({
    line: explainLineId, issues, alerts: disruptions,
    reliability: snapshot.reliability, crowding,
  });
  const delayMetrics = delaySnapshot.metrics;
  const onlineMetrics = delayMetrics?.onlineCalibration;
  const onlineModel = delaySnapshot.model?.onlineCalibration;
  const delayRequirements = delayMetrics?.requirements || {};
  const preliminaryRequirements = delayRequirements.preliminary || { minimumDays: 2, minimumExamples: 150 };
  const collectionProgress = Math.min(100, Math.round(100 * Math.min(
    (delayMetrics?.dataDays || 0) / preliminaryRequirements.minimumDays,
    (delayMetrics?.labelledJourneyCount || 0) / preliminaryRequirements.minimumExamples,
  )));
  const delayPredictions = delaySnapshot.status === 'ready' || onlineModel?.status === 'ready'
    ? LINES.map((line) => {
      const incidentContext = incidentContextForLine(disruptions, line, now);
      const predictions = arrivalStore.getNetworkArrivals(now)
        .filter((arrival) => arrival.isLive && arrival.line === line && arrival.seconds >= 240 && arrival.seconds <= 900)
        .map((arrival) => {
          const enriched = { ...arrival, ...incidentContext };
          return predictFinalDelay(delaySnapshot.model, enriched, now)
            ?? predictOnlineDelay(delaySnapshot.model, enriched);
        })
        .filter(Number.isFinite);
      return predictions.length ? { line, minutes: Math.max(...predictions) } : null;
    }).filter(Boolean)
    : [];
  const vehicles = useMemo(() => trainPositionEngine.getAllVehicles(now), [now]);
  const entries = [...arrivalStore.memory.values()];

  useEffect(() => {
    const unsubscribe = delayModelStore.subscribe(setDelaySnapshot);
    delayModelStore.load();
    const refresh = setInterval(() => delayModelStore.load(), 10 * 60 * 1000);
    return () => { unsubscribe(); clearInterval(refresh); };
  }, []);
  useEffect(() => subscribeReports(setReports), []);

  return (
    <aside className="glass-panel intelligence-panel" aria-label="Rail intelligence">
      <header className="intelligence-header">
        <div className="intelligence-title">
          <Activity size={18} />
          <div><strong>Rail intelligence</strong><span>Predictions with their evidence exposed</span></div>
        </div>
        <button className="panel-close-button" onClick={onClose} aria-label="Close rail intelligence"><X size={17} /></button>
      </header>

      <nav className="intelligence-tabs" aria-label="Rail intelligence views">
        {[
          ['forecast', Radar, 'Forecast'], ['signals', Activity, 'Signals'], ['history', History, 'History'],
          ['access', Accessibility, 'Access'], ['explain', Bot, 'Explain'],
          ['advisor', Sparkles, 'Advisor'], ['operations', Gauge, 'Operations'],
        ].map(([id, Icon, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)} aria-pressed={tab === id}>
            <Icon size={14} />{label}
          </button>
        ))}
      </nav>

      {tab === 'forecast' && <>
        <section className="intelligence-section">
          <div className="intelligence-section-title"><AlertTriangle size={14} /><strong>Gap & bunching radar</strong></div>
          {issues.length === 0 ? <div className="intelligence-ok"><i />No unusual U-Bahn intervals detected</div> : (
            <div className="intelligence-issues">{issues.slice(0, 4).map((issue) => (
              <div className={`intelligence-issue ${issue.type}`} key={issue.id}>
                <span className="intelligence-line" style={{ background: lineColor(issue.line) }}>{issue.line}</span>
                <div><strong>{issue.type === 'gap' ? 'Service gap' : 'Trains close together'}</strong><span>{issue.label} towards {issue.direction} · {issue.station}</span></div>
              </div>
            ))}</div>
          )}
        </section>

        <section className="intelligence-section delay-model-card">
          <div className="intelligence-section-title">
            <Activity size={14} /><strong>Fast online calibration</strong>
            <em className={onlineMetrics?.status === 'ready' ? 'model-ready' : ''}>
              {onlineMetrics?.status === 'ready' ? 'Early experimental' : 'Learning'}
            </em>
          </div>
          {onlineMetrics?.status === 'ready' ? <>
            <div className="delay-metric-grid">
              <div><span>Prequential MAE</span><strong>{onlineMetrics.model.maeMinutes} min</strong></div>
              <div><span>RMSE</span><strong>{onlineMetrics.model.rmseMinutes} min</strong></div>
              <div><span>Within ±1 min</span><strong>{onlineMetrics.model.withinOneMinutePercent}%</strong></div>
              <div><span>Scored journeys</span><strong>{onlineMetrics.scoredJourneyCount}</strong></div>
            </div>
            {onlineMetrics.deployment?.deployed === false && (
              <div className="model-holdback">Online adjustment held back: it has not beaten the unadjusted live estimate.</div>
            )}
            <p className="intelligence-note">Every journey was predicted before its final value arrived, scored afterward, and only then used to improve later predictions. The seven-day model below remains separate.</p>
          </> : <>
            <div className="model-progress"><i style={{ width: `${Math.min(100, Math.round(100 * (onlineMetrics?.scoredJourneyCount || 0) / (onlineMetrics?.minimumExamples || 30)))}%` }} /></div>
            <div className="model-collection-stats">
              <strong>{onlineMetrics?.scoredJourneyCount || 0}/{onlineMetrics?.minimumExamples || 30}</strong><span>completed journeys</span>
            </div>
            <p className="intelligence-note">This can publish leakage-free early metrics within hours. No score is shown until at least {onlineMetrics?.minimumExamples || 30} journeys have been predicted and completed.</p>
          </>}
        </section>

        <section className="intelligence-section delay-model-card">
          <div className="intelligence-section-title">
            <Activity size={14} /><strong>U-Bahn delay model</strong>
            <em className={delaySnapshot.status === 'ready' ? 'model-ready' : ''}>
              {delaySnapshot.status === 'ready'
                ? delayMetrics?.validationStage === 'validated' ? 'Validated' : 'Preliminary'
                : delaySnapshot.status === 'error' ? 'Unavailable' : 'Collecting'}
            </em>
          </div>
          {delaySnapshot.status === 'ready' ? <>
            <div className="delay-metric-grid">
              <div><span>MAE</span><strong>{delayMetrics.model.maeMinutes} min</strong></div>
              <div><span>RMSE</span><strong>{delayMetrics.model.rmseMinutes} min</strong></div>
              <div><span>Within ±1 min</span><strong>{delayMetrics.model.withinOneMinutePercent}%</strong></div>
              <div><span>Delay accuracy</span><strong>{delayMetrics.model.delayedThreeMinutes.accuracyPercent}%</strong></div>
              <div><span>Delay F1</span><strong>{delayMetrics.model.delayedThreeMinutes.f1}</strong></div>
              <div><span>Test journeys</span><strong>{delayMetrics.model.sampleCount}</strong></div>
            </div>
            {delayMetrics.deployment?.deployed === false && (
              <div className="model-holdback">Model held back: its test MAE did not beat the live-estimate baseline.</div>
            )}
            {delayPredictions.length > 0 && <div className="delay-line-predictions">
              {delayPredictions.map((prediction) => (
                <span key={prediction.line}><i style={{ background: lineColor(prediction.line) }}>{prediction.line}</i>
                  {prediction.minutes < 0.5 ? 'on time' : `+${prediction.minutes.toFixed(1)} min`}
                </span>
              ))}
            </div>}
            <p className="intelligence-note">Scored on the newest 20% of complete calendar days, kept outside training. “Delay accuracy” classifies delays of 3+ minutes. {delayMetrics.promotion}</p>
          </> : delaySnapshot.status === 'error' ? (
            <div className="model-collection-copy">The published model report could not be loaded.</div>
          ) : <>
            <div className="model-progress"><i style={{ width: `${collectionProgress}%` }} /></div>
            <div className="model-collection-stats">
              <strong>{delayMetrics?.observationCount || 0}</strong><span>observations</span>
              <strong>{delayMetrics?.labelledJourneyCount || 0}</strong><span>labelled journeys</span>
              <strong>{delayMetrics?.dataDays || 0}/{preliminaryRequirements.minimumDays}</strong><span>days to preliminary</span>
            </div>
            <p className="intelligence-note">No accuracy is shown yet. A preliminary score starts after at least {preliminaryRequirements.minimumDays} days, {preliminaryRequirements.minimumCoverageHours || 36} hours of coverage and {preliminaryRequirements.minimumExamples} journeys. It is automatically promoted after {delayRequirements.validated?.minimumDays || 7} days.</p>
          </>}
          {delayMetrics?.labelQuality && (
            <p className="model-label-caveat">Training labels: {delayMetrics.labelQuality.officialLabelledJourneys.toLocaleString('en-GB')} official Wiener Linien delay values{delayMetrics.labelQuality.fallbackLabelledJourneys ? ` · ${delayMetrics.labelQuality.fallbackLabelledJourneys} legacy fallback labels` : ''}.</p>
          )}
          {delayMetrics?.incidentContext?.archiveImported && (
            <p className="intelligence-note">Incident context includes {delayMetrics.incidentContext.archivedUbahnEpisodes.toLocaleString('en-GB')} official historical U-Bahn episodes plus current service messages.</p>
          )}
          <p className="model-label-caveat">Target: Wiener Linien’s final reported <code>timeReal − timePlanned</code>, not independent GPS ground truth.</p>
        </section>

        <DelayTimeline
          arrivals={arrivalStore.getNetworkArrivals(now)}
          now={now}
          predictions={delayPredictions}
          disruptions={disruptions}
        />

        <section className="intelligence-section">
          <div className="intelligence-section-title"><Radar size={14} /><strong>Irregularity propagation</strong><em>Experimental</em></div>
          <div className="propagation-grid">{forecasts.map((forecast) => (
            <div key={forecast.minutes}>
              <strong>+{forecast.minutes} min</strong>
              {forecast.lines.length ? forecast.lines.slice(0, 4).map((item) => (
                <span key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i>{item.risk}%</span>
              )) : <small>No current signal</small>}
            </div>
          ))}</div>
          <p className="intelligence-note">Risk that today’s gap or disruption persists and reaches connecting lines—not predicted delay minutes.</p>
        </section>

        <section className="intelligence-section">
          <div className="intelligence-section-title"><Activity size={14} /><strong>Passenger-pressure proxy</strong><em>Not occupancy</em></div>
          <div className="crowding-grid">{crowding.map((item) => (
            <div key={item.line} className={item.level} title={item.reason}>
              <span style={{ color: lineColor(item.line) }}>{item.line}</span><strong>{item.level}</strong>
              <i style={{ width: `${item.score}%` }} />
            </div>
          ))}</div>
          <p className="intelligence-note">A transparent time-and-service-gap risk model. Passenger-count data is not publicly available.</p>
        </section>
      </>}

      {tab === 'signals' && <AdvancedSignals
        now={now} issues={issues} forecasts={forecasts} disruptions={disruptions}
        crowding={crowding} accessibility={accessibility} reliability={snapshot.reliability || []}
        vehicles={vehicles} entries={entries} modelHealth={delaySnapshot.health}
      />}

      {tab === 'operations' && <OperationsDashboard
        now={now} issues={issues} disruptions={disruptions} crowding={crowding}
        vehicles={vehicles} reliability={snapshot.reliability || []} reports={reports}
        modelHealth={delaySnapshot.health} delayPredictions={delayPredictions}
      />}

      {tab === 'history' && <>
        <section className="intelligence-section">
          <div className="intelligence-section-title"><Clock3 size={14} /><strong>Network replay</strong></div>
          <div className="replay-time-row">
            <span>{replayOffset > 0
              ? `Viewing ${ageLabel(replaySnapshot?.at || officialReplaySnapshot?.at)}`
              : 'LIVE'}</span>
            {replayOffset > 0 && <button onClick={() => onReplayChange(0)}>Return to live</button>}
          </div>
          <input className="replay-slider" type="range" min="0" max={Math.max(1, replayMaxMinutes)} step="1"
            value={Math.min(replayOffset, Math.max(1, replayMaxMinutes))}
            onChange={(event) => onReplayChange(Number(event.target.value))}
            disabled={replayMaxMinutes < 1} aria-label="Minutes to replay" />
          <div className="replay-scale"><span>Live</span><span>{replayMaxMinutes ? `${replayMaxMinutes} min ago` : 'Collecting history…'}</span></div>
          {replayOffset > oldestMinutes && <p className="intelligence-note">This point is beyond the one-hour map-position archive; the official delay replay below remains available.</p>}
          <p className="intelligence-note">Map positions retain one hour of inferred movement. Compact official Wiener Linien delay snapshots are archived every ten minutes for up to 48 hours on this device.</p>
        </section>

        <section className="intelligence-section official-replay-section">
          <div className="intelligence-section-title"><Database size={14} /><strong>Official delay replay</strong><em>Wiener Linien</em></div>
          {officialSummary ? <>
            <div className="official-replay-meta">
              <span>{officialSummary.at ? ageLabel(officialSummary.at) : '—'}</span>
              <span>{officialSummary.stations} stations · {officialSummary.observations} departures</span>
            </div>
            <div className="official-replay-metrics">
              <div><span>Mean reported delay</span><strong>{officialSummary.meanDelaySeconds === null ? '—' : `${(officialSummary.meanDelaySeconds / 60).toFixed(1)} min`}</strong></div>
              <div><span>At least 3 min late</span><strong>{officialSummary.delayedThreeMinutes}</strong></div>
              <div><span>Labelled observations</span><strong>{officialSummary.labelledObservations}</strong></div>
            </div>
            <div className="official-replay-lines">
              {officialSummary.lines.filter((line) => line.observations > 0).map((line) => (
                <span key={line.line}><b style={{ color: lineColor(line.line) }}>{line.line}</b>{line.meanDelaySeconds === null ? '—' : `${(line.meanDelaySeconds / 60).toFixed(1)}m`}</span>
              ))}
            </div>
            <p className="intelligence-note">These are operator-reported timeReal − timePlanned values, not GPS measurements. The map location remains inferred from those departures.</p>
          </> : <div className="model-collection-copy">Waiting for the first official ten-minute snapshot.</div>}
        </section>

        <section className="intelligence-section reliability-section">
          <div className="intelligence-section-title"><History size={14} /><strong>Reliability atlas</strong></div>
          <button className={`atlas-toggle ${atlasVisible ? 'active' : ''}`} onClick={onToggleAtlas} aria-pressed={atlasVisible}>
            {atlasVisible ? 'Hide reliability on map' : 'Show reliability on map'}
          </button>
          <div className="reliability-atlas">{(snapshot.reliability || []).map((item) => (
            <div key={item.line}>
              <span style={{ color: lineColor(item.line) }}>{item.line}</span>
              <div><i style={{ width: `${item.score ?? 0}%`, background: lineColor(item.line) }} /></div>
              <strong>{item.observations < 3 || item.score === null ? 'Learning' : `${item.score}%`}</strong>
            </div>
          ))}</div>
          <p className="intelligence-note">Seven-day, on-device history of five-minute observations without detected gaps or bunching.</p>
        </section>
      </>}

      {tab === 'access' && (
        <section className="intelligence-section accessibility-intelligence">
          <div className="intelligence-section-title"><Accessibility size={14} /><strong>Step-free network resilience</strong></div>
          {accessibility.length ? accessibility.map((impact) => (
            <div className={`accessibility-impact ${impact.severity}`} key={impact.id}>
              <div><strong>{impact.station}</strong><span>{impact.lines.join(' · ') || 'Station'} · {impact.status}</span></div>
              <p>{impact.impact}</p>
              {impact.alternatives.length > 0 && <small>Nearby access points to check: {impact.alternatives.join(', ')}</small>}
            </div>
          )) : <div className="intelligence-ok"><i />No elevator outage found in the current feed</div>}
          <p className="intelligence-note">Nearby stations are suggestions to check, not guaranteed step-free alternatives.</p>
        </section>
      )}

      {tab === 'explain' && <>
        <section className="intelligence-section network-explainer">
          <div className="intelligence-section-title"><Bot size={14} /><strong>Explain this line</strong></div>
          <div className="explain-lines">{LINES.map((line) => (
            <button key={line} onClick={() => setExplainLineId(line)} className={line === explainLineId ? 'active' : ''} style={{ '--line-color': lineColor(line) }}>{line}</button>
          ))}</div>
          <div className="explanation-answer">
            <strong>{explanation.status}</strong><p>{explanation.summary}</p>
            <small>Generated only from live predictions, official notices and this device’s history.</small>
          </div>
        </section>
        <section className="intelligence-section"><OnboardPilot /></section>
      </>}

      {tab === 'advisor' && <RailAdvisor
        snapshot={snapshot} disruptions={disruptions} forecasts={forecasts}
        crowding={crowding} accessibility={accessibility} delayMetrics={delayMetrics}
        delayPredictions={delayPredictions} now={now}
      />}
    </aside>
  );
};

export default RailIntelligence;

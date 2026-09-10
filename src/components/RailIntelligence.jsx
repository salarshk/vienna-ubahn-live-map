import React, { useState } from 'react';
import { Accessibility, Activity, AlertTriangle, Bot, Clock3, History, Radar, X } from 'lucide-react';
import { lineColor } from '../utils/lineColor';
import {
  analyseAccessibility,
  estimateCrowdingRisk,
  explainLine,
  forecastDelayPropagation,
  LINES,
} from '../services/transitModels';
import OnboardPilot from './OnboardPilot';

const ageLabel = (timestamp) => {
  if (!timestamp) return 'now';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(new Date(timestamp));
};

const RailIntelligence = ({
  snapshot, disruptions = [], replayOffset, replaySnapshot, onReplayChange,
  atlasVisible, onToggleAtlas, onClose,
}) => {
  const [tab, setTab] = useState('forecast');
  const [explainLineId, setExplainLineId] = useState('U1');
  const now = snapshot.generatedAt || 0;
  const oldestMinutes = snapshot.replay.first
    ? Math.min(60, Math.floor((now - snapshot.replay.first) / 60000)) : 0;
  const issues = snapshot.issues || [];
  const forecasts = forecastDelayPropagation(issues, disruptions);
  const crowding = estimateCrowdingRisk(issues, new Date(now));
  const accessibility = analyseAccessibility(disruptions);
  const explanation = explainLine({
    line: explainLineId, issues, alerts: disruptions,
    reliability: snapshot.reliability, crowding,
  });

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
          ['forecast', Radar, 'Forecast'], ['history', History, 'History'],
          ['access', Accessibility, 'Access'], ['explain', Bot, 'Explain'],
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

      {tab === 'history' && <>
        <section className="intelligence-section">
          <div className="intelligence-section-title"><Clock3 size={14} /><strong>Network replay</strong></div>
          <div className="replay-time-row">
            <span>{replaySnapshot ? `Viewing ${ageLabel(replaySnapshot.at)}` : 'LIVE'}</span>
            {replayOffset > 0 && <button onClick={() => onReplayChange(0)}>Return to live</button>}
          </div>
          <input className="replay-slider" type="range" min="0" max={Math.max(1, oldestMinutes)} step="1"
            value={Math.min(replayOffset, Math.max(1, oldestMinutes))}
            onChange={(event) => onReplayChange(Number(event.target.value))}
            disabled={oldestMinutes < 1} aria-label="Minutes to replay" />
          <div className="replay-scale"><span>Live</span><span>{oldestMinutes ? `${oldestMinutes} min ago` : 'Collecting history…'}</span></div>
          <p className="intelligence-note">This browser retains up to one hour of estimated positions on this device.</p>
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
    </aside>
  );
};

export default RailIntelligence;

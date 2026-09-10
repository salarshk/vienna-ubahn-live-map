import React from 'react';
import { Activity, AlertTriangle, Clock3, X } from 'lucide-react';
import { lineColor } from '../utils/lineColor';

const ageLabel = (timestamp) => {
  if (!timestamp) return 'now';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(new Date(timestamp));
};

const RailIntelligence = ({ snapshot, replayOffset, replaySnapshot, onReplayChange, onClose }) => {
  const oldestMinutes = snapshot.replay.first
    ? Math.min(60, Math.floor((Date.now() - snapshot.replay.first) / 60000))
    : 0;
  const issues = snapshot.issues || [];

  return (
    <aside className="glass-panel intelligence-panel" aria-label="Rail intelligence">
      <header className="intelligence-header">
        <div className="intelligence-title">
          <Activity size={18} />
          <div><strong>Rail intelligence</strong><span>Network behaviour, not just departures</span></div>
        </div>
        <button className="panel-close-button" onClick={onClose} aria-label="Close rail intelligence"><X size={17} /></button>
      </header>

      <section className="intelligence-section">
        <div className="intelligence-section-title"><Clock3 size={14} /><strong>Replay</strong></div>
        <div className="replay-time-row">
          <span>{replaySnapshot ? `Viewing ${ageLabel(replaySnapshot.at)}` : 'LIVE'}</span>
          {replayOffset > 0 && <button onClick={() => onReplayChange(0)}>Return to live</button>}
        </div>
        <input
          className="replay-slider"
          type="range"
          min="0"
          max={Math.max(1, oldestMinutes)}
          step="1"
          value={Math.min(replayOffset, Math.max(1, oldestMinutes))}
          onChange={(event) => onReplayChange(Number(event.target.value))}
          disabled={oldestMinutes < 1}
          aria-label="Minutes to replay"
        />
        <div className="replay-scale"><span>Live</span><span>{oldestMinutes ? `${oldestMinutes} min ago` : 'Collecting history…'}</span></div>
        <p className="intelligence-note">This browser retains up to one hour of estimated positions on this device.</p>
      </section>

      <section className="intelligence-section">
        <div className="intelligence-section-title"><AlertTriangle size={14} /><strong>Gap & bunching radar</strong></div>
        {issues.length === 0 ? (
          <div className="intelligence-ok"><i />No unusual U-Bahn intervals detected</div>
        ) : (
          <div className="intelligence-issues">
            {issues.slice(0, 5).map((issue) => (
              <div className={`intelligence-issue ${issue.type}`} key={issue.id}>
                <span className="intelligence-line" style={{ background: lineColor(issue.line) }}>{issue.line}</span>
                <div><strong>{issue.type === 'gap' ? 'Service gap' : 'Trains close together'}</strong><span>{issue.label} towards {issue.direction} · seen at {issue.station}</span></div>
              </div>
            ))}
          </div>
        )}
        <p className="intelligence-note">Detected from consecutive live departure predictions; it is not an official disruption notice.</p>
      </section>

      <section className="intelligence-section reliability-section">
        <div className="intelligence-section-title"><Activity size={14} /><strong>Observed reliability</strong></div>
        <div className="reliability-grid">
          {(snapshot.reliability || []).map((item) => (
            <div key={item.line}>
              <span style={{ color: lineColor(item.line) }}>{item.line}</span>
              <strong>{item.observations < 3 || item.score === null ? 'Learning' : `${item.score}%`}</strong>
            </div>
          ))}
        </div>
        <p className="intelligence-note">Share of this browser’s five-minute observations without a detected gap or bunch.</p>
      </section>
    </aside>
  );
};

export default RailIntelligence;

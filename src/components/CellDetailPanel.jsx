import React from 'react';
import { Activity, Accessibility, ArrowRight, Clock3, CloudRain, Grid2X2, ShieldCheck, Timer, TrainFront, TriangleAlert, Users, X } from 'lucide-react';

const minutes = (seconds) => {
  const value = Number(seconds) || 0;
  if (Math.abs(value) < 30) return 'on time';
  return `${value >= 0 ? '+' : ''}${(value / 60).toFixed(1)} min`;
};

const CellDetailPanel = ({ cell, onClose }) => {
  if (!cell) return null;
  const context = cell.contextModels || {};
  return <aside className="glass-panel cell-detail-panel" aria-label={`50 metre cell details for ${cell.displayName}`}>
    <header className="cell-detail-header">
      <div className="cell-detail-title"><Grid2X2 size={17} /><div><strong>{cell.displayName}</strong><span>50 × 50 m cell · {cell.id}</span></div></div>
      <button className="panel-close-button" onClick={onClose} aria-label="Close cell details"><X size={16} /></button>
    </header>
    <div className="cell-detail-kpis">
      <span><Timer size={13} /><b>{minutes(cell.meanDelaySeconds)}</b><small>mean delay</small></span>
      <span><ShieldCheck size={13} /><b>{cell.reliability}/100</b><small>reliability</small></span>
      <span><Users size={13} /><b>{cell.crowdPressure}/100</b><small>pressure proxy</small></span>
      <span><Clock3 size={13} /><b>{cell.etaMinutes == null ? '—' : `${cell.etaMinutes}m`}</b><small>next ETA</small></span>
    </div>
    <div className="cell-detail-list">
      <div><TrainFront size={13} /><span>Lines</span><b>{cell.lines.join(' · ') || '—'}</b></div>
      <div><ArrowRight size={13} /><span>Direction</span><b>{cell.dominantDirection || 'not resolved'}</b></div>
      <div><TriangleAlert size={13} /><span>Recovery</span><b>{cell.recoveryMinutes ? `${cell.recoveryMinutes} min` : 'normal'}</b></div>
      <div><Activity size={13} /><span>Anomaly score</span><b>{cell.anomalyScore}/100</b></div>
      <div><Accessibility size={13} /><span>Accessibility issues</span><b>{cell.accessibilityIssues || 'none reported'}</b></div>
      {cell.userDistanceMetres != null && <div><Grid2X2 size={13} /><span>From your GPS</span><b>{Math.round(cell.userDistanceMetres)} m</b></div>}
    </div>
    <div className="cell-detail-context"><CloudRain size={13} /><span>Context</span><b>{context.traffic?.congestionScore ?? 0}/100 road pressure · {context.airport?.railPressureLevel || 'routine'} airport wave · {context.comfort?.level || 'baseline'} outdoor comfort</b></div>
    <p className="intelligence-note">Train positions may be inferred from departure predictions. Pressure, recovery and context values are model estimates, not passenger counts or control-room commands.</p>
  </aside>;
};

export default CellDetailPanel;

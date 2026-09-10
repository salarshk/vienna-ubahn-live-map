import React, { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Clock3, Database, MapPin, Radio, X } from 'lucide-react';
import trainPositionEngine from '../services/trainPositionEngine';
import { lineColor } from '../utils/lineColor';

const directionLabel = (bearing) => {
  if (!Number.isFinite(bearing)) return '—';
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${points[Math.round(bearing / 45) % 8]} · ${Math.round(bearing)}°`;
};

const dueLabel = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'now';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
};

const VehiclePanel = ({ vehicle, onClose }) => {
  const [current, setCurrent] = useState(vehicle);
  const [isPresent, setIsPresent] = useState(true);

  useEffect(() => {
    const update = () => {
      const next = trainPositionEngine.getAllVehicles(Date.now())
        .find((candidate) => candidate.id === vehicle.id);
      if (next) setCurrent(next);
      setIsPresent(Boolean(next));
    };
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [vehicle]);

  const source = current.isLive
    ? { label: 'LIVE ESTIMATE', icon: Radio, color: '#4CAF50', detail: 'Inferred from Wiener Linien departure predictions — not GPS.' }
    : current.isScheduled
      ? { label: 'SCHEDULED', icon: Database, color: '#00B4D8', detail: 'Interpolated from the ÖBB timetable — not live GPS.' }
      : { label: 'SIMULATED', icon: Database, color: '#ffb74d', detail: 'Fallback movement shown because no usable live prediction is available.' };
  const SourceIcon = source.icon;
  const futureStops = useMemo(
    () => (current.upcomingStations || []).filter((name) => name && name !== current.targetStation).slice(0, 2),
    [current.upcomingStations, current.targetStation]
  );

  return (
    <aside className="glass-panel station-panel vehicle-panel" aria-label={`${current.line} train details`}>
      <header className="vehicle-panel-header">
        <div className="vehicle-line-badge" style={{ background: lineColor(current.line) }}>{current.line}</div>
        <div className="vehicle-panel-title">
          <div className="vehicle-heading">Towards {current.direction}</div>
          <div className="vehicle-source" style={{ color: source.color }}>
            <SourceIcon size={11} className={current.isLive ? 'pulse' : ''} /> {source.label}
          </div>
        </div>
        <button className="panel-close-button" onClick={onClose} aria-label="Close train details"><X size={17} /></button>
      </header>

      <div className="vehicle-next-stop">
        <div>
          <span>Next station</span>
          <strong>{current.targetStation || 'Unknown'}</strong>
        </div>
        <div className="vehicle-due"><Clock3 size={16} /> {dueLabel(current.secondsToTarget)}</div>
      </div>

      <div className="vehicle-detail-grid">
        <div><span>Status</span><strong>{isPresent ? current.status || 'En Route' : 'No longer reported'}</strong></div>
        <div><span>Heading</span><strong>{directionLabel(current.bearing)}</strong></div>
        <div><span>Previous</span><strong>{current.previousStation || 'Origin'}</strong></div>
        <div>
          <span>Position</span>
          <strong>{current.isLive ? `${Math.round((current.positionConfidence ?? 1) * 100)}% confidence` : current.isScheduled ? 'Timetable estimate' : 'Fallback estimate'}</strong>
        </div>
      </div>

      {futureStops.length > 0 && (
        <div className="vehicle-upcoming">
          <span>Then</span>
          <div>{futureStops.map((stop) => <span key={stop}><ChevronRight size={13} />{stop}</span>)}</div>
        </div>
      )}

      <footer className="vehicle-panel-note"><MapPin size={13} /> {source.detail}</footer>
    </aside>
  );
};

export default VehiclePanel;

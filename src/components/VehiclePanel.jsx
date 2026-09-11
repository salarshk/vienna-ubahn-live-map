import React, { useEffect, useMemo, useState } from 'react';
import { Activity, ChevronRight, Clock3, Database, MapPin, Radio, Shuffle, X } from 'lucide-react';
import trainPositionEngine from '../services/trainPositionEngine';
import arrivalStore from '../services/arrivalStore';
import delayModelStore from '../services/delayModel';
import disruptionStore from '../services/disruptionStore';
import { estimateConnections } from '../services/networkIntelligence';
import { predictVehicleDelay, predictVehicleDwell } from '../services/vehiclePredictions';
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

const delayLabel = (minutes) => {
  if (!Number.isFinite(minutes)) return 'Not available';
  if (minutes <= 0.1) return 'On time';
  return `${minutes > 0 ? '+' : ''}${minutes.toFixed(1)} min`;
};

const rangeLabel = (low, high) => {
  if (!Number.isFinite(low) || !Number.isFinite(high)) return 'No range yet';
  return `${delayLabel(low)} to ${delayLabel(high)}`;
};

const VehiclePanel = ({ vehicle, onClose }) => {
  const [current, setCurrent] = useState(vehicle);
  const [isPresent, setIsPresent] = useState(true);
  const [delayModelSnapshot, setDelayModelSnapshot] = useState(() => delayModelStore.getSnapshot());
  const [disruptions, setDisruptions] = useState(() => disruptionStore.getSnapshot().alerts || []);

  useEffect(() => {
    if (vehicle.isReplay) {
      setCurrent(vehicle);
      setIsPresent(true);
      return undefined;
    }
    const update = () => {
      const next = trainPositionEngine.getAllVehicles(Date.now())
        .find((candidate) => candidate.id === vehicle.id);
      if (next) setCurrent(next);
      setIsPresent(Boolean(next));
    };
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [vehicle]);

  useEffect(() => {
    if (!current.isLive || current.isReplay) return;
    const names = [current.targetStation, ...(current.upcomingStations || [])]
      .filter((name, index, all) => name && all.indexOf(name) === index)
      .slice(0, 3);
    names.forEach((name) => {
      const station = trainPositionEngine.findStation(current.line, name);
      if (station) arrivalStore.getStationArrivals({ name: station.name, apiId: station.apiId });
    });
  }, [current.isLive, current.isReplay, current.line, current.targetStation, current.upcomingStations]);

  useEffect(() => {
    const unsubscribe = delayModelStore.subscribe(setDelayModelSnapshot);
    void delayModelStore.load();
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = disruptionStore.subscribe((snapshot) => setDisruptions(snapshot.alerts || []));
    // The application normally refreshes this store on boot. Refreshing here
    // also makes a directly opened train panel self-contained.
    void disruptionStore.refresh();
    return unsubscribe;
  }, []);

  const source = current.isReplay
    ? { label: 'REPLAY', icon: Clock3, color: '#ffb74d', detail: `Recorded estimate from ${new Date(current.replayedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.` }
    : current.isLive
    ? { label: 'OFFICIAL TIMING · INFERRED POSITION', icon: Radio, color: '#4CAF50', detail: 'Timing is from Wiener Linien timeReal/timePlanned; the map position is inferred, not GPS.' }
    : current.isScheduled
      ? { label: 'SCHEDULED', icon: Database, color: '#00B4D8', detail: 'Interpolated from the ÖBB timetable — not live GPS.' }
      : { label: 'SIMULATED', icon: Database, color: '#ffb74d', detail: 'Fallback movement shown because no usable live prediction is available.' };
  const SourceIcon = source.icon;
  const futureStops = useMemo(
    () => (current.upcomingStations || []).filter((name) => name && name !== current.targetStation).slice(0, 2),
    [current.upcomingStations, current.targetStation]
  );
  const connections = current.isReplay ? [] : estimateConnections(current, Date.now());
  const predictionNow = Date.now();
  const delayPrediction = predictVehicleDelay({
    vehicle: current,
    arrivals: arrivalStore.getNetworkArrivals(predictionNow),
    disruptions,
    modelSnapshot: delayModelSnapshot,
    now: predictionNow,
  });
  const dwellPrediction = predictVehicleDwell({ vehicle: current });

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
        {current.isLive && (
          <div>
            <span>Probable range</span>
            <strong>±{Math.max(0, current.positionUncertaintyMetres || 0)} m on track</strong>
          </div>
        )}
        {current.isLive && Number.isFinite(Number(current.officialDelaySeconds)) && (
          <div>
            <span>Official reported delay</span>
            <strong>{(Number(current.officialDelaySeconds) / 60).toFixed(1)} min</strong>
          </div>
        )}
      </div>

      <section className="vehicle-predictions" aria-label="Per-train predictions">
        <div className="vehicle-predictions-title"><Activity size={13} /><span>Per-train predictions</span><em>decision support</em></div>
        <div className="vehicle-prediction-grid">
          <div className="vehicle-prediction-card">
            <span>Delay at {delayPrediction.station}</span>
            <strong>{delayLabel(delayPrediction.predictedMinutes)}</strong>
            <small>{rangeLabel(delayPrediction.lowMinutes, delayPrediction.highMinutes)} · {delayPrediction.confidence}% confidence</small>
            <small>{delayPrediction.source}</small>
          </div>
          <div className="vehicle-prediction-card">
            <span>{dwellPrediction?.status || 'Dwell forecast'}</span>
            <strong>{dwellPrediction ? `${dwellPrediction.predictedMinutes.toFixed(1)} min` : 'Not available'}</strong>
            <small>{dwellPrediction ? `${dwellPrediction.lowMinutes.toFixed(1)}–${dwellPrediction.highMinutes.toFixed(1)} min · ${dwellPrediction.confidence}% confidence` : 'No position data yet'}</small>
            <small>{dwellPrediction?.source || 'Awaiting train data'}</small>
          </div>
        </div>
        <p>Forecasts use the train’s official timing where available and the map’s inferred position; they are not operator guarantees.</p>
      </section>

      {futureStops.length > 0 && (
        <div className="vehicle-upcoming">
          <span>Then</span>
          <div>{futureStops.map((stop) => <span key={stop}><ChevronRight size={13} />{stop}</span>)}</div>
        </div>
      )}

      {current.isLive && !current.isReplay && (
        <div className="vehicle-connections">
          <div className="vehicle-connections-title"><Shuffle size={13} /><span>Connection forecast</span></div>
          {connections.length > 0 ? (
            <>
              <strong className="vehicle-connection-station">At {connections[0].station} · includes 2 min to change</strong>
              {connections.map((connection) => (
                <div className="vehicle-connection" key={`${connection.station}-${connection.line}-${connection.destination}`}>
                  <span className="vehicle-connection-line" style={{ background: lineColor(connection.line) }}>{connection.line}</span>
                  <div><strong>towards {connection.destination}</strong><span>{dueLabel(connection.departureSeconds)} from now · {connection.rating}</span></div>
                  <b className={`connection-probability ${connection.rating}`}>{connection.probability}%</b>
                </div>
              ))}
            </>
          ) : (
            <p>No cross-line live departure is available at the next three stations.</p>
          )}
          <small>Estimated from public predictions and walking time—not a guarantee.</small>
        </div>
      )}

      <footer className="vehicle-panel-note"><MapPin size={13} /> {source.detail}</footer>
    </aside>
  );
};

export default VehiclePanel;

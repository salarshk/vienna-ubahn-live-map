import React, { useEffect, useMemo, useState } from 'react';
import { Clock3, MapPin, RefreshCw, Search, TrainFront, X } from 'lucide-react';
import arrivalStore, { NETWORK_SYNC_INTERVAL_MS } from '../services/arrivalStore';
import trainPositionEngine from '../services/trainPositionEngine';
import { lineColor } from '../utils/lineColor';

const INITIAL_NOW = Date.now();

const ageLabel = (vehicle) => {
  if (vehicle.isScheduled) return 'Timetable position';
  if (vehicle.lastDataAgeSeconds === null || vehicle.lastDataAgeSeconds === undefined) return 'No age signal';
  return vehicle.lastDataAgeSeconds <= 3
    ? `Fresh · ${Math.max(1, Math.round(vehicle.lastDataAgeSeconds))}s ago`
    : `${Math.round(vehicle.lastDataAgeSeconds)}s old`;
};

const statusLabel = (vehicle) => {
  if (vehicle.isScheduled) return 'Scheduled';
  if (vehicle.isSimulated) return 'Inferred fallback';
  if (vehicle.isLive) return 'Live';
  return 'Unknown';
};

const FleetTracker = ({ theme = 'dark', onClose, onSelectVehicle }) => {
  const [now, setNow] = useState(INITIAL_NOW);
  const [vehicles, setVehicles] = useState(() => trainPositionEngine.getAllVehicles(INITIAL_NOW));
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);

  const update = () => {
    const current = Date.now();
    setNow(current);
    setVehicles(trainPositionEngine.getAllVehicles(current));
  };

  useEffect(() => {
    const unsubscribe = arrivalStore.subscribe(update);
    const timer = setInterval(update, NETWORK_SYNC_INTERVAL_MS);
    return () => { unsubscribe(); clearInterval(timer); };
  }, []);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await arrivalStore.syncNetwork(); } finally { update(); setRefreshing(false); }
  };

  const counts = useMemo(() => ({
    all: vehicles.length,
    live: vehicles.filter((vehicle) => vehicle.isLive).length,
    scheduled: vehicles.filter((vehicle) => vehicle.isScheduled).length,
    fallback: vehicles.filter((vehicle) => vehicle.isSimulated).length,
  }), [vehicles]);

  const visibleVehicles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return vehicles
      .filter((vehicle) => filter === 'all'
        || (filter === 'live' && vehicle.isLive)
        || (filter === 'scheduled' && vehicle.isScheduled)
        || (filter === 'fallback' && vehicle.isSimulated))
      .filter((vehicle) => !needle || [
        vehicle.line, vehicle.vehicleId, vehicle.direction, vehicle.targetStation,
        vehicle.sourceStationName, vehicle.positionSource,
      ].some((value) => String(value || '').toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.isLive) - Number(a.isLive)
        || String(a.line).localeCompare(String(b.line))
        || String(a.direction).localeCompare(String(b.direction))
        || String(a.id).localeCompare(String(b.id)));
  }, [vehicles, filter, query]);

  const isLight = theme === 'light';

  return (
    <div className="fleet-tracker-overlay" role="dialog" aria-modal="true" aria-label="All trains live tracker">
      <section className="fleet-tracker">
        <header className="fleet-tracker-header">
          <div className="fleet-tracker-title"><div className="fleet-tracker-kicker"><TrainFront size={15} /> Fleet view</div><h1>All trains</h1><p>Every visible U-Bahn and S-Bahn service, with freshness and position provenance exposed.</p></div>
          <div className="fleet-tracker-actions"><div className="fleet-tracker-clock"><Clock3 size={15} />{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div><button className="fleet-tracker-icon-button" onClick={refresh} disabled={refreshing} aria-label="Refresh all trains" title="Refresh all trains"><RefreshCw size={17} className={refreshing ? 'fleet-tracker-spin' : ''} /></button><button className="fleet-tracker-icon-button" onClick={onClose} aria-label="Close all trains tracker" title="Close tracker"><X size={19} /></button></div>
        </header>

        <div className="fleet-tracker-toolbar">
          <label className="fleet-tracker-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search line, train, destination or station" aria-label="Search trains" /></label>
          <div className="fleet-tracker-filters" role="group" aria-label="Filter trains">{[
            ['all', `All ${counts.all}`], ['live', `Live ${counts.live}`], ['scheduled', `S-Bahn ${counts.scheduled}`], ['fallback', `Fallback ${counts.fallback}`],
          ].map(([id, label]) => <button key={id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)} aria-pressed={filter === id}>{label}</button>)}</div>
        </div>

        <div className="fleet-tracker-meta"><span>{visibleVehicles.length} train{visibleVehicles.length === 1 ? '' : 's'} shown</span><span><i className="fleet-tracker-fresh-dot" />Live map data · updates every {NETWORK_SYNC_INTERVAL_MS / 1000}s</span></div>

        <div className="fleet-tracker-list" aria-live="polite">
          {visibleVehicles.length ? visibleVehicles.map((vehicle) => <button className="fleet-tracker-row" key={vehicle.id} onClick={() => onSelectVehicle(vehicle)}>
            <span className="fleet-tracker-line" style={{ background: lineColor(vehicle.line) }}>{vehicle.line}</span>
            <span className="fleet-tracker-main"><strong>{vehicle.direction || 'Direction unavailable'}</strong><span><MapPin size={11} /> {vehicle.targetStation || vehicle.sourceStationName || 'Position in corridor'}{vehicle.vehicleId ? ` · train ${vehicle.vehicleId}` : ''}</span></span>
            <span className={`fleet-tracker-state ${vehicle.isLive ? 'live' : vehicle.isScheduled ? 'scheduled' : 'fallback'}`}>{statusLabel(vehicle)}<small>{ageLabel(vehicle)}</small></span>
            <span className="fleet-tracker-delay">{Number.isFinite(vehicle.officialDelaySeconds) ? `${vehicle.officialDelaySeconds > 0 ? '+' : ''}${Math.round(vehicle.officialDelaySeconds / 60)}m` : vehicle.secondsToTarget !== undefined ? `${Math.max(0, Math.round(vehicle.secondsToTarget / 60))}m` : '—'}<small>{vehicle.isLive ? 'delay' : vehicle.isScheduled ? 'to next' : 'estimate'}</small></span>
          </button>) : <div className="fleet-tracker-empty"><TrainFront size={26} /><strong>No trains match this filter</strong><span>Try another line, station, destination, or feed filter.</span></div>}
        </div>

        <footer className="fleet-tracker-footer"><span>Tap any row to select that train on the map.</span><span className={isLight ? 'fleet-tracker-source-light' : ''}>Live U-Bahn positions are inferred from official departure predictions; S-Bahn positions are timetable-based.</span></footer>
      </section>
    </div>
  );
};

export default FleetTracker;

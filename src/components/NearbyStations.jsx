import React, { useMemo } from 'react';
import { MapPin, X } from 'lucide-react';
import { findNearbyStations } from '../services/userLocation';
import { lineColor } from '../utils/lineColor';

const NearbyStations = ({ userLocation, onSelectStation, onClose }) => {
  const nearby = useMemo(() => userLocation?.coordinates ? findNearbyStations(userLocation.coordinates, 2500).slice(0, 5) : [], [userLocation]);
  if (!userLocation || userLocation.status !== 'located') return null;
  return <aside className="glass-panel nearby-stations" aria-label="Nearby stations">
    <header><span><MapPin size={14} /> Nearby stations</span><button onClick={onClose} aria-label="Close nearby stations"><X size={14} /></button></header>
    {nearby.length ? nearby.map(({ station, distance }) => <button className="nearby-station-row" key={station.properties.name} onClick={() => onSelectStation(station)}>
      <span className="nearby-station-lines">{(station.properties.lines || []).slice(0, 3).map((line) => <i key={line} style={{ background: lineColor(line) }}>{line}</i>)}</span>
      <strong>{station.properties.name}</strong><small>{Math.round(distance)} m</small>
    </button>) : <p>No station found within 2.5 km.</p>}
    <small className="nearby-accuracy">GPS accuracy ±{Number.isFinite(userLocation.accuracy) ? Math.round(userLocation.accuracy) : '—'} m</small>
  </aside>;
};

export default NearbyStations;

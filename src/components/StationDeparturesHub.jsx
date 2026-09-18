import React, { useEffect, useMemo, useState } from 'react';
import { Clock3, Database, MapPin, RefreshCw, Search, X } from 'lucide-react';
import arrivalStore, { MAJOR_STATIONS, STRATEGIC_HUBS } from '../services/arrivalStore';
import { getStationFocus } from '../services/stationFocus';
import { countdownHeat, countdownLabel } from '../utils/countdownHeat';
import { lineColor } from '../utils/lineColor';
import gtfsData from '../data/gtfs_expanded.json';
import tramData from '../data/tram_network.json';

const stationFeatures = [
  ...(gtfsData.features || []),
  ...(tramData.features || []),
].filter((feature) => feature.geometry?.type === 'Point' && feature.properties?.type === 'station');
const featureByKey = new Map(stationFeatures.flatMap((feature) => [
  [`id:${feature.properties.apiId}`, feature],
  [`name:${feature.properties.name}`, feature],
]));
const stationCatalog = [...new Map([...STRATEGIC_HUBS, ...MAJOR_STATIONS].map((station) => [String(station.id), station])).values()]
  .map((station) => featureByKey.get(`id:${station.id}`) || {
    type: 'Feature', geometry: { type: 'Point', coordinates: [16.372, 48.208] },
    properties: { type: 'station', apiId: station.id, name: station.name, lines: station.lines || [] },
  })
  .map((feature) => ({
    ...feature,
    properties: { ...feature.properties, apiId: Number(feature.properties.apiId) },
  }));

const StationDeparturesHub = ({ theme = 'dark', onClose, onSelectStation }) => {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(stationCatalog[0]?.properties.apiId);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [, setStoreVersion] = useState(0);

  const selectedStation = stationCatalog.find((station) => station.properties.apiId === selectedId) || stationCatalog[0];
  const focus = getStationFocus(selectedStation?.properties, now);
  const filteredStations = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return stationCatalog.filter((station) => !needle || station.properties.name.toLowerCase().includes(needle));
  }, [query]);

  useEffect(() => {
    const unsubscribe = arrivalStore.subscribe(() => setStoreVersion((version) => version + 1));
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { unsubscribe(); clearInterval(clock); };
  }, []);

  useEffect(() => {
    if (!selectedStation) return undefined;
    arrivalStore.getStationArrivals(selectedStation.properties);
    const refresh = setInterval(() => arrivalStore.getStationArrivals(selectedStation.properties), 5000);
    return () => clearInterval(refresh);
  }, [selectedStation]);

  const refreshStation = async () => {
    if (!selectedStation || refreshing) return;
    setRefreshing(true);
    try { await arrivalStore.getStationArrivals(selectedStation.properties, { forceRefresh: true }); }
    finally { setRefreshing(false); }
  };

  const chooseStation = (station) => {
    setSelectedId(station.properties.apiId);
    setQuery('');
  };

  return (
    <div className="station-hub-overlay" role="dialog" aria-modal="true" aria-label="Station departures hub">
      <section className="station-hub">
        <header className="station-hub-header">
          <div className="station-hub-heading">
            <span className="station-hub-kicker"><MapPin size={14} /> Live platform view</span>
            <h1>Station departures hub</h1>
            <p>Choose a station to see its next rail or tram departures and open it on the map.</p>
          </div>
          <button className="station-hub-icon-button" onClick={onClose} aria-label="Close station departures hub" title="Close"><X size={18} /></button>
        </header>

        <div className="station-hub-body">
          <aside className="station-hub-stations">
            <label className="station-hub-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search stations" aria-label="Search stations" /></label>
            <div className="station-hub-station-list">
              {filteredStations.map((station) => {
                const lines = station.properties.lines || [];
                return <button className={`station-hub-station ${selectedId === station.properties.apiId ? 'selected' : ''}`} key={station.properties.apiId} onClick={() => chooseStation(station)}>
                  <strong>{station.properties.name}</strong>
                  <span>{lines.length ? lines.join(' · ') : 'Rail stop'}</span>
                </button>;
              })}
              {!filteredStations.length && <p className="station-hub-empty-small">No station matches “{query}”.</p>}
            </div>
          </aside>

          <main className="station-hub-departures">
            <div className="station-hub-departures-header">
              <div><span className="station-hub-kicker"><MapPin size={13} /> Selected station</span><h2>{focus.name || selectedStation?.properties.name}</h2></div>
              <div className="station-hub-departures-actions">
                <span className={`station-hub-feed-status ${focus.isFresh ? 'live' : ''}`}><Database size={12} /> {focus.isFresh ? 'Live feed' : focus.hasScheduled ? 'Timetable' : 'Memory'}</span>
                <button className="station-hub-icon-button" onClick={refreshStation} disabled={refreshing} aria-label="Refresh station departures" title="Refresh departures"><RefreshCw size={16} className={refreshing ? 'spin' : ''} /></button>
              </div>
            </div>
            <div className="station-hub-line-summary">
              {[...(new Set([...(selectedStation?.properties.lines || []), ...focus.arrivals.map((arrival) => arrival.line)]))].map((line) => <span key={line} style={{ background: lineColor(line) }}>{line}</span>)}
              <small>{focus.secondsUnheard == null ? 'No feed timestamp yet' : `Feed ${focus.secondsUnheard < 5 ? 'just now' : `${focus.secondsUnheard}s ago`}`}</small>
            </div>
            {focus.arrivals.length ? <div className="station-hub-arrivals" aria-live="polite">
              {focus.arrivals.slice(0, 12).map((arrival, index) => <button className="station-hub-arrival" key={`${arrival.line}-${arrival.destination}-${arrival.targetTimestamp}-${index}`} onClick={() => onSelectStation?.(selectedStation)}>
                <span className="station-hub-arrival-line" style={{ background: lineColor(arrival.line) }}>{arrival.line}</span>
                <span className="station-hub-arrival-main"><strong>Towards {arrival.destination}</strong><small>{arrival.platform || arrival.gate ? `Platform ${arrival.platform || arrival.gate}` : arrival.status} · {arrival.isLive ? 'official real-time' : 'inferred timetable'}</small></span>
                <b style={{ color: countdownHeat(arrival.seconds, theme) }}>{countdownLabel(arrival.seconds)}<small>{arrival.seconds > 0 ? ' min' : ''}</small></b>
              </button>)}
            </div> : <div className="station-hub-empty"><Clock3 size={25} /><strong>No departures in memory yet</strong><span>Keep this station open while the next five-second network sync arrives.</span></div>}
            <button className="station-hub-open-map" onClick={() => onSelectStation?.(selectedStation)}><MapPin size={15} /> Open {focus.name || 'station'} on the map</button>
          </main>
        </div>
        <footer className="station-hub-footer">Countdowns are projected from the last official Wiener Linien response and refresh every five seconds when available.</footer>
      </section>
    </div>
  );
};

export default StationDeparturesHub;

import React, { useEffect, useState } from 'react';
import { Clock3, RefreshCw, TrainFront, X } from 'lucide-react';
import arrivalStore, { NETWORK_SYNC_INTERVAL_MS } from '../services/arrivalStore';
import { getStationFocus } from '../services/stationFocus';
import { countdownHeat, countdownLabel } from '../utils/countdownHeat';
import { lineColor } from '../utils/lineColor';

// Interchanges cover all five operating U-Bahn lines while keeping the
// selector small enough to work as a touch target on an iPhone.
const BOARD_STATIONS = [
  { apiId: 60201320, name: 'Stephansplatz', lines: ['U1', 'U3'] },
  { apiId: 60201182, name: 'Schottenring', lines: ['U2', 'U4'] },
  { apiId: 60201468, name: 'Westbahnhof', lines: ['U3', 'U6'] },
];
const INITIAL_NOW = Date.now();

const freshnessLabel = (focus) => {
  if (focus.secondsUnheard === null) return 'Waiting for station data';
  if (focus.isFresh) return `Live · updated ${Math.max(1, focus.secondsUnheard)}s ago`;
  return `Cached · updated ${Math.max(1, Math.round(focus.secondsUnheard / 60))}m ago`;
};

const DashboardBoard = ({ theme, onExit }) => {
  const [now, setNow] = useState(INITIAL_NOW);
  const [slot, setSlot] = useState(0);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    arrivalStore.syncNetwork();
    const sync = setInterval(() => arrivalStore.syncNetwork(), NETWORK_SYNC_INTERVAL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(sync); clearInterval(tick); };
  }, []);

  const refresh = async () => {
    if (syncing) return;
    setSyncing(true);
    try { await arrivalStore.syncNetwork(); } finally { setSyncing(false); setNow(Date.now()); }
  };

  const station = BOARD_STATIONS[slot];
  const focus = getStationFocus(station, now);
  const rows = focus.arrivals.slice(0, 10);
  const nextByDirection = focus.directions
    .map((direction) => ({ ...direction, next: direction.arrivals[0] }))
    .filter((direction) => direction.next);

  return (
    <main className="departure-board-app" aria-label="Live station departures">
      <header className="departure-board-header">
        <div className="departure-board-brand">
          <div className="departure-board-kicker"><TrainFront size={14} /> Vienna Rail · live board</div>
          <div className="departure-board-heading-row">
            <h1>{station.name}</h1>
            <div className={`departure-board-status ${focus.isFresh ? 'live' : ''}`}><i />{focus.isFresh ? 'LIVE' : 'STALE'}</div>
          </div>
          <div className="departure-board-line-list">{station.lines.map((line) => <span key={line} style={{ '--line-color': lineColor(line) }}>{line}</span>)}</div>
        </div>
        <div className="departure-board-header-actions">
          <div className="departure-board-clock"><Clock3 size={15} /><span>{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
          <button className="departure-board-icon-button" onClick={refresh} disabled={syncing} aria-label="Refresh departures" title="Refresh departures"><RefreshCw size={17} className={syncing ? 'departure-board-spin' : ''} /></button>
          <button className="departure-board-icon-button" onClick={onExit} aria-label="Return to map" title="Return to map"><X size={19} /></button>
        </div>
      </header>

      <div className="departure-board-layout">
        <aside className="departure-board-stations" aria-label="Choose station">
          <div className="departure-board-section-label">Stations</div>
          {BOARD_STATIONS.map((item, index) => <button key={item.name} className={index === slot ? 'active' : ''} onClick={() => setSlot(index)} aria-pressed={index === slot}>
            <span className="departure-board-station-marker">{String(index + 1).padStart(2, '0')}</span>
            <span><strong>{item.name}</strong><small>{item.lines.join(' · ')}</small></span>
          </button>)}
          <div className="departure-board-station-help">Choose a station to pause the board. It no longer changes stations automatically.</div>
        </aside>

        <section className="departure-board-content">
          <div className="departure-board-content-header">
            <div><span className="departure-board-section-label">Next departures</span><p>{freshnessLabel(focus)}</p></div>
            <span className="departure-board-count">{rows.length} shown</span>
          </div>

          {rows.length ? <div className="departure-board-arrivals">
            {rows.map((arrival, index) => <article className="departure-board-arrival" key={`${arrival.line}-${arrival.destination}-${arrival.targetTimestamp}-${index}`}>
              <span className="departure-board-line" style={{ background: lineColor(arrival.line) }}>{arrival.line}</span>
              <div className="departure-board-destination"><strong>{arrival.destination}</strong><span>{arrival.isLive ? 'Live Wiener Linien prediction' : 'Scheduled service'}{arrival.reportedDelaySeconds > 0 ? ` · +${Math.round(arrival.reportedDelaySeconds / 60)} min reported` : ''}</span></div>
              <time dateTime={new Date(arrival.targetTimestamp).toISOString()}>{new Date(arrival.targetTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              <strong className="departure-board-countdown" style={{ color: countdownHeat(arrival.seconds, theme) }}>{countdownLabel(arrival.seconds)}<small>{arrival.seconds > 0 ? 'min' : 'now'}</small></strong>
            </article>)}
          </div> : <div className="departure-board-empty"><TrainFront size={24} /><strong>No departures available</strong><span>{focus.fetchError || 'Waiting for a fresh station response.'}</span><button onClick={refresh}>Try again</button></div>}

          <div className="departure-board-direction-section">
            <div className="departure-board-section-label">Direction summary</div>
            <div className="departure-board-direction-grid">{nextByDirection.map((direction) => <div key={direction.key} className="departure-board-direction-card">
              <span className="departure-board-line small" style={{ background: lineColor(direction.line) }}>{direction.line}</span>
              <div><strong>{direction.label}</strong><small>{direction.direction === 'forward' ? 'Outbound platform' : 'Inbound platform'}</small></div>
              <b style={{ color: countdownHeat(direction.next.seconds, theme) }}>{countdownLabel(direction.next.seconds)}<small>min</small></b>
            </div>)}</div>
          </div>
        </section>
      </div>

      <footer className="departure-board-footer"><span>Operator predictions · locations are inferred from official departures</span><span>{focus.hasRealtime ? 'Realtime feed connected' : focus.hasScheduled ? 'Timetable fallback' : 'No current feed'}</span></footer>
    </main>
  );
};

export default DashboardBoard;

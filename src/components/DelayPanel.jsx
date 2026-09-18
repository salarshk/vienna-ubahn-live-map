import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, Database, RefreshCw } from 'lucide-react';
import { lineColor } from '../utils/lineColor';
import delayReportStore from '../services/delayReportStore';
import { buildDelayRankings } from '../services/delayReportStore';

const minutes = (seconds) => {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) < 30) return 'on time';
  return `${value >= 0 ? '+' : ''}${(value / 60).toFixed(1)} min`;
};

const age = (timestamp, now) => {
  if (!timestamp) return 'not recorded yet';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
};

const DelayRows = ({ rows, kind, compact = false }) => {
  const visible = rows.slice(0, compact ? 5 : 12);
  if (!visible.length) return <p className="advanced-empty">No official delay observations are available yet.</p>;
  return <div className="delay-ranking-list">{visible.map((item, index) => {
    const label = kind === 'trains' ? item.vehicleId || item.trainKey : kind === 'stations' ? item.station || item.id : item.line || item.id;
    const detail = kind === 'trains'
      ? `${item.station || 'station unknown'} → ${item.destination || 'destination unknown'}${item.direction && item.direction !== '—' ? ` · ${item.direction}` : ''}`
      : kind === 'stations' ? `${(item.lines || []).join(' · ') || 'line unknown'} · ${item.samples} observations` : `${item.samples} observations · ${item.delayedThreeMinutes || 0} at least 3 min late`;
    return <div className="delay-ranking-row" key={`${kind}-${item.id}-${index}`}>
      <b className="delay-ranking-index">{index + 1}</b>
      {kind !== 'stations' && <i style={{ background: lineColor(item.line || item.id) }}>{item.line || item.id}</i>}
      <div><strong>{label}</strong><span>{detail}</span></div>
      <b className={item.meanDelaySeconds >= 180 ? 'risk-high' : item.meanDelaySeconds >= 60 ? 'risk-medium' : ''}>{minutes(item.meanDelaySeconds)}</b>
      {!compact && <small>max {minutes(item.maxDelaySeconds)}</small>}
    </div>;
  })}</div>;
};

const DelayPanel = ({ entries = [], now = 0, compact = false }) => {
  const [view, setView] = useState('trains');
  const [period, setPeriod] = useState('daily');
  const [storeSnapshot, setStoreSnapshot] = useState(delayReportStore.getSnapshot());
  const live = useMemo(() => buildDelayRankings(entries, now), [entries, now]);
  const report = delayReportStore.getReport(period, now);
  useEffect(() => delayReportStore.subscribe(setStoreSnapshot), []);

  const rows = compact ? live : period === 'live' ? live : report;
  const title = compact ? 'Current delay leaderboard' : 'Delay reports';
  const periodLabel = period === 'live' ? 'live official observations' : `${period} report`;

  return <section className={`intelligence-section delay-panel${compact ? ' delay-panel-compact' : ''}`}>
    <div className="intelligence-section-title"><BarChart3 size={14} /><strong>{title}</strong><em>{compact ? 'Who is most delayed now' : 'Ranked official observations'}</em></div>
    {!compact && <div className="delay-panel-controls">
      <div className="delay-panel-tabs" role="tablist" aria-label="Delay ranking type">{[['trains', 'Trains'], ['stations', 'Stations'], ['lines', 'Lines']].map(([id, label]) => <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>{label}</button>)}</div>
      <label><span>Window</span><select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="live">Live</option><option value="hourly">Last hour</option><option value="daily">Last day</option><option value="weekly">Last week</option><option value="monthly">Last month</option><option value="yearly">Last year</option></select></label>
    </div>}
    {compact && <div className="delay-panel-compact-tabs">{[['trains', 'Train'], ['stations', 'Station'], ['lines', 'Line']].map(([id, label]) => <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>{label}</button>)}</div>}
    <DelayRows rows={rows[view] || []} kind={view} compact={compact} />
    {!compact && <div className="delay-panel-footer"><span><Database size={12} /> {periodLabel} · {rows.observations || 0} observations</span><span>Saved {age(storeSnapshot.lastRecordedAt, now)}</span><button onClick={() => setStoreSnapshot(delayReportStore.getSnapshot())} title="Refresh report"><RefreshCw size={12} /></button></div>}
    {compact && <p className="intelligence-note">Live official timeReal − timePlanned observations. Open the <strong>Delays</strong> tab for historical hourly, daily, weekly, monthly and yearly reports.</p>}
  </section>;
};

export default DelayPanel;

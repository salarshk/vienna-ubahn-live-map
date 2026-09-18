import React, { useEffect, useMemo, useState } from 'react';
import { Accessibility, Activity, Bike, CloudRain, Grid2X2, History, MapPinned, Navigation, Plane, RadioTower, Route, ShieldCheck, Timer, TrainFront, TriangleAlert, Users, Wind } from 'lucide-react';
import { buildCellIntelligence, gridReportStore } from '../services/gridIntelligence';

const formatDelay = (seconds) => {
  const value = Number(seconds) || 0;
  if (Math.abs(value) < 30) return 'on time';
  return `${value >= 0 ? '+' : ''}${(value / 60).toFixed(1)} min`;
};

const CellRow = ({ cell, metric = 'risk' }) => {
  if (!cell) return null;
  const value = metric === 'delay' ? formatDelay(cell.meanDelaySeconds)
    : metric === 'pressure' ? `${cell.crowdPressure}/100`
      : metric === 'reliability' ? `${cell.reliability}/100`
        : `${cell.recoveryMinutes} min`;
  const details = [
    cell.lines.join(' · ') || 'network',
    cell.dominantDirection ? `towards ${cell.dominantDirection}` : null,
    cell.etaMinutes == null ? null : `next ${cell.etaMinutes} min`,
    cell.anomalyScore > 0 ? `anomaly ${cell.anomalyScore}` : `${cell.observations} observations`,
  ].filter(Boolean).join(' · ');
  return <div className="cell-intelligence-row">
    <span className="cell-intelligence-rank">{cell.stations[0] || cell.lines.join(' · ') || cell.id}</span>
    <small>{details}{cell.userDistanceMetres == null ? '' : ` · ${Math.round(cell.userDistanceMetres)} m away`}</small>
    <b className={cell.severity === 'high' ? 'risk-high' : cell.severity === 'medium' ? 'risk-medium' : ''}>{value}</b>
  </div>;
};

const contextRows = (context = {}) => [
  ['Weather', context.weatherNowcast?.description || context.weather?.description || 'not connected', CloudRain],
  ['Air quality', context.airQuality?.pm10 == null ? 'not connected' : `PM10 ${context.airQuality.pm10}`, Wind],
  ['Bike fallback', context.bikeShare?.availableBikes == null ? 'not connected' : `${context.bikeShare.availableBikes} bikes`, Bike],
  ['Airport pressure', context.airport?.activity || context.airportActivity?.activity || 'proxy only', Plane],
];

const CellIntelligencePanel = ({
  entries = [], vehicles = [], issues = [], disruptions = [], context = {}, userLocation = null,
  now = 0, compact = false, cellGridVisible = false, onToggleCellGrid,
}) => {
  const [view, setView] = useState('overview');
  const [period, setPeriod] = useState('daily');
  const [, setStoreVersion] = useState(0);
  const grid = useMemo(() => buildCellIntelligence({ vehicles, entries, issues, disruptions, context, userLocation, now }), [vehicles, entries, issues, disruptions, context, userLocation, now]);
  const report = gridReportStore.getReport(period);

  useEffect(() => {
    const unsubscribe = gridReportStore.subscribe(() => setStoreVersion((version) => version + 1));
    gridReportStore.record(grid.cells, now);
    return unsubscribe;
  }, [grid, now]);

  const ranked = grid.rankings;
  const topDelay = ranked.delay.slice(0, compact ? 3 : 8);
  const topCrowd = ranked.crowd.slice(0, compact ? 3 : 8);
  const topRecovery = ranked.recovery.slice(0, compact ? 3 : 8);

  if (compact) return <section className="intelligence-section cell-intelligence-panel cell-intelligence-compact">
    <div className="intelligence-section-title"><Grid2X2 size={14} /><strong>200 m cell intelligence</strong><em>Vienna-wide spatial layer</em></div>
    {topDelay.length ? <div className="cell-intelligence-list">{topDelay.map((cell) => <CellRow key={cell.id} cell={cell} metric="delay" />)}</div> : <p className="advanced-empty">Waiting for live cell observations.</p>}
    <div className="cell-intelligence-summary"><span>{grid.activeCells?.length || 0} active · {grid.cells.length} covered</span><span>{grid.nearestUserCell ? `Nearest: ${grid.nearestUserCell.displayName}` : 'GPS not active'}</span></div>
    <button className={`cell-grid-toggle ${cellGridVisible ? 'active' : ''}`} onClick={onToggleCellGrid} aria-pressed={cellGridVisible}><Grid2X2 size={12} /> {cellGridVisible ? 'Hide map grid' : 'Show delay grid on map'}</button>
  </section>;

  return <section className="intelligence-section cell-intelligence-panel">
    <div className="intelligence-section-title"><Grid2X2 size={15} /><strong>200 × 200 m Vienna grid</strong><em>{grid.activeCells?.length || 0} active · {grid.cells.length} covered</em></div>
    <p className="intelligence-note">Each cell combines measured live timing with clearly labelled position, crowd and recovery proxies. Raw GPS is never stored as a user history.</p>
    <div className="cell-intelligence-controls">
      <div className="cell-intelligence-tabs">
        {[["overview", Grid2X2, 'Overview'], ["delay", Timer, 'Delay'], ["flow", TrainFront, 'Flow'], ["access", Accessibility, 'Access'], ["context", CloudRain, 'Context'], ["reports", History, 'Reports']].map(([id, Icon, label]) => <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}><Icon size={13} />{label}</button>)}
      </div>
      <button className={`cell-grid-toggle ${cellGridVisible ? 'active' : ''}`} onClick={onToggleCellGrid} aria-pressed={cellGridVisible}><Grid2X2 size={12} /> {cellGridVisible ? 'Hide map grid' : 'Show map grid'}</button>
    </div>

    {view === 'overview' && <>
      <div className="cell-intelligence-kpis"><span><strong>{grid.cells.length}</strong>cells</span><span><strong>{grid.cells.filter((cell) => cell.liveTrainCount).length}</strong>live train areas</span><span><strong>{grid.cells.filter((cell) => cell.disruptionCount).length}</strong>affected areas</span><span><strong>{grid.cells.filter((cell) => cell.anomalyScore > 0).length}</strong>anomaly cells</span></div>
      <div className="cell-intelligence-section-title"><Activity size={13} /> Highest-risk cells</div>
      <div className="cell-intelligence-list">{grid.cells.slice(0, 10).map((cell) => <CellRow key={cell.id} cell={cell} />)}</div>
      <div className="cell-intelligence-feature-grid"><span><Navigation size={12} /><b>ETA</b><small>Cell-to-station arrival estimate and confidence</small></span><span><ShieldCheck size={12} /><b>Reliability</b><small>Delay, gaps and disruption combined</small></span><span><Route size={12} /><b>Route risk</b><small>Risk-adjusted corridor and transfer quality</small></span><span><Users size={12} /><b>Pressure</b><small>Service-pressure proxy, not passenger counting</small></span></div>
    </>}

    {view === 'delay' && <>
      <div className="cell-intelligence-section-title"><Timer size={13} /> Delay and recovery forecast</div>
      <div className="cell-intelligence-list">{topDelay.map((cell) => <CellRow key={cell.id} cell={cell} metric="delay" />)}</div>
      <div className="cell-intelligence-section-title"><TriangleAlert size={13} /> Slowest recovery locations</div>
      <div className="cell-intelligence-list">{topRecovery.map((cell) => <CellRow key={cell.id} cell={cell} metric="recovery" />)}</div>
      <p className="intelligence-note">Delay propagation uses current delay, direction, gaps, bunching and active alerts. It forecasts exposure; it is not a direct signal from the control room.</p>
    </>}

    {view === 'flow' && <>
      <div className="cell-intelligence-section-title"><RadioTower size={13} /> Train flow and spacing</div>
      <div className="cell-intelligence-list">{topCrowd.map((cell) => <CellRow key={cell.id} cell={cell} metric="pressure" />)}</div>
      <div className="cell-intelligence-kpis"><span><strong>{grid.cells.filter((cell) => cell.gapRisk > 0).length}</strong>gap cells</span><span><strong>{grid.cells.filter((cell) => cell.bunchingRisk > 0).length}</strong>bunching cells</span><span><strong>{grid.cells.filter((cell) => cell.dwellRisk > 0).length}</strong>dwell-risk cells</span><span><strong>{grid.cells.filter((cell) => cell.positionStale).length}</strong>stale-position cells</span></div>
      <p className="intelligence-note">Flow direction is inferred from the train-position engine and departure sequences; S-Bahn locations remain timetable-based where GPS is unavailable.</p>
    </>}

    {view === 'access' && <>
      <div className="cell-intelligence-section-title"><Accessibility size={13} /> Accessibility and transfer quality</div>
      <div className="cell-intelligence-list">{ranked.access.length ? ranked.access.slice(0, 10).map((cell) => <CellRow key={cell.id} cell={cell} metric="reliability" />) : <p className="advanced-empty">No active accessibility issue is mapped.</p>}</div>
      <div className="cell-intelligence-feature-grid"><span><MapPinned size={12} /><b>Coverage</b><small>Lines and live departures present in the cell</small></span><span><Route size={12} /><b>Transfer chance</b><small>Estimated chance of making a current interchange</small></span><span><Navigation size={12} /><b>GPS distance</b><small>Distance to the nearest cell and station</small></span><span><ShieldCheck size={12} /><b>Access impact</b><small>Lift/elevator alerts and alternatives</small></span></div>
    </>}

    {view === 'context' && <>
      <div className="cell-intelligence-section-title"><CloudRain size={13} /> External context by cell</div>
      <div className="cell-intelligence-context-grid">{contextRows(context).map(([label, value, Icon]) => <span key={label}><Icon size={13} /><b>{label}</b><small>{value}</small></span>)}
        <span><Activity size={13} /><b>Road pressure</b><small>{grid.cells[0]?.contextModels?.traffic?.congestionScore ?? 0}/100 · {grid.cells[0]?.contextModels?.traffic?.observations || 0} observations</small></span>
        <span><Plane size={13} /><b>Airport wave</b><small>{grid.cells[0]?.contextModels?.airport?.railPressureLevel || 'routine'} · {grid.cells[0]?.contextModels?.airport?.railPressureScore ?? 0}/100</small></span>
        <span><Users size={13} /><b>Events</b><small>{grid.cells[0]?.contextModels?.events?.level || 'routine'} · {grid.cells[0]?.contextModels?.events?.score ?? 0}/100</small></span>
        <span><ShieldCheck size={13} /><b>Outdoor comfort</b><small>{grid.cells[0]?.contextModels?.comfort?.level || 'baseline'} · {grid.cells[0]?.contextModels?.comfort?.score ?? 0}/100</small></span>
      </div>
      <div className="cell-intelligence-feature-grid"><span><CloudRain size={12} /><b>Weather walking</b><small>Transfer comfort and tram exposure</small></span><span><Wind size={12} /><b>Air quality</b><small>Environmental context, not medical advice</small></span><span><Bike size={12} /><b>Bike fallback</b><small>Alternative availability near a cell</small></span><span><Plane size={12} /><b>Airport wave</b><small>Airport-to-rail demand probability</small></span></div>
    </>}

    {view === 'reports' && <>
      <div className="cell-intelligence-controls"><label>Report window <select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label></div>
      <div className="cell-intelligence-list">{report.slice(0, 12).map((cell) => <div className="cell-intelligence-row" key={cell.id}><span className="cell-intelligence-rank">{cell.name || cell.id}</span><small>{cell.samples} samples · risk {cell.meanRisk}/100</small><b>{formatDelay(cell.meanDelaySeconds)}</b></div>)}{!report.length && <p className="advanced-empty">Reports will fill as the map observes live service.</p>}</div>
      <p className="intelligence-note">Saved as compact cell aggregates in this browser: 14 days hourly, 370 days daily, 110 weeks, 72 months and 10 years yearly.</p>
    </>}
  </section>;
};

export default CellIntelligencePanel;

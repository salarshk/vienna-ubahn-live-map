import React, { useMemo } from 'react';
import { Gauge, ShieldAlert } from 'lucide-react';
import { lineColor } from '../utils/lineColor';
import { estimateNetworkOccupancy } from '../services/occupancyEstimation';
import { summariseReports } from '../services/communityReports';
import { classifyDelayCauses } from '../services/delayCause';
import { LINES } from '../services/transitModels';
import { buildControlRoomActions } from '../services/advancedIntelligence';

const OperationsDashboard = ({ now, issues = [], disruptions = [], crowding = [], vehicles = [], reliability = [], reports = [], modelHealth, delayPredictions = [], forecasts = [] }) => {
  const occupancy = useMemo(() => estimateNetworkOccupancy({ now, crowding, issues, vehicles, reports }), [now, crowding, issues, vehicles, reports]);
  const reportSummary = useMemo(() => summariseReports(reports, now), [reports, now]);
  const actions = useMemo(() => buildControlRoomActions({ issues, disruptions, crowding, forecasts }), [issues, disruptions, crowding, forecasts]);
  const lines = LINES.map((line) => {
    const lineIssues = issues.filter((item) => item.line === line);
    const lineIncidents = disruptions.filter((item) => item.lines?.includes(line));
    const lineVehicles = vehicles.filter((item) => item.line === line && item.isLive);
    const lineReports = reportSummary.byLine.find((item) => item.line === line);
    const cause = classifyDelayCauses({ line, issues, disruptions, reports })[0];
    const forecast = delayPredictions.find((item) => item.line === line);
    const reliabilityItem = reliability.find((item) => item.line === line);
    const occupancyItem = occupancy.find((item) => item.line === line);
    return { line, lineIssues, lineIncidents, lineVehicles, lineReports, cause, forecast, reliabilityItem, occupancyItem };
  });

  return <section className="intelligence-section operations-dashboard">
    <div className="intelligence-section-title"><Gauge size={14} /><strong>Operations analysis</strong><em>Decision support</em></div>
    <p className="intelligence-note advanced-intro">A line-by-line control-room view built from public passenger data, model estimates and optional reports. It recommends verification priorities; it cannot control trains or signals.</p>
    <div className="operations-summary"><span><strong>{lines.filter((item) => item.lineIssues.length || item.lineIncidents.length).length}</strong> lines needing attention</span><span><strong>{reportSummary.total}</strong> passenger reports</span><span><strong>{modelHealth?.status || 'unknown'}</strong> model monitor</span></div>
    <div className="operations-grid">{lines.map((item) => {
      const attention = item.lineIncidents.length ? 'disrupted' : item.lineIssues.length ? 'watch' : 'stable';
      return <article className={`operations-line-card ${attention}`} key={item.line}>
        <header><i style={{ background: lineColor(item.line) }}>{item.line}</i><div><strong>{attention === 'disrupted' ? 'Disrupted' : attention === 'watch' ? 'Watch' : 'Stable'}</strong><span>{item.lineVehicles.length} inferred trains</span></div><b>{item.forecast ? `+${item.forecast.minutes.toFixed(1)}m` : '—'}</b></header>
        <div className="operations-line-metrics"><span><small>Occupancy</small><strong>{item.occupancyItem?.level || 'unknown'}</strong></span><span><small>Reliability</small><strong>{item.reliabilityItem?.score == null ? 'learning' : `${item.reliabilityItem.score}%`}</strong></span><span><small>Reports</small><strong>{item.lineReports?.total || 0}</strong></span></div>
        <p>{item.cause ? `${item.cause.cause} · ${item.cause.evidence}` : 'No line-specific cause signal detected.'}</p>
        <small className="operations-action">{attention === 'disrupted' ? 'Verify official incident scope and passenger messaging.' : attention === 'watch' ? 'Check headway and downstream transfer impact.' : 'Keep under routine observation.'}</small>
      </article>;
    })}</div>
    <div className="advanced-card operations-actions-card">
      <div className="advanced-card-title"><strong>Human-reviewed control-room suggestions</strong><span>not automatic control</span></div>
      <div className="advanced-list">{actions.map((item) => <div className="advanced-row" key={item.line}>
        <i style={{ background: lineColor(item.line) }}>{item.line}</i>
        <div><strong>{item.action}</strong><span>{item.reason}</span></div>
        <b>{item.confidence}%</b><small>review</small>
      </div>)}</div>
      <small className="advanced-caveat">These recommendations use public passenger-facing data and must never be sent directly to trains, signals, or staff without an authorised human decision.</small>
    </div>
    <div className="operations-limitations"><ShieldAlert size={14} /><span>Public feeds do not expose dispatcher telemetry, exact train GPS or verified passenger counts. Treat every action as human-reviewed decision support.</span></div>
  </section>;
};

export default OperationsDashboard;

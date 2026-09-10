import React, { useEffect, useMemo, useState } from 'react';
import { Accessibility, Activity, AlertTriangle, GitBranch, MapPin, ShieldCheck, Users } from 'lucide-react';
import { lineColor } from '../utils/lineColor';
import { getSbahnFreshness } from '../services/dataFreshness';
import {
  buildCalendarPressure, buildCauseSignals, buildDataQuality, buildDirectionSignals,
  buildDwellSignals, buildEtaUncertainty, buildRecoveryForecast, buildStationSignals,
  buildRouteRisk, buildTransferHealth, simulateNetworkScenario,
} from '../services/advancedIntelligence';
import { LINES } from '../services/transitModels';
import { addReport, getReports, REPORT_CATEGORIES, subscribe as subscribeReports, summariseReports } from '../services/communityReports';
import { estimateNetworkOccupancy } from '../services/occupancyEstimation';
import { classifyDelayCauses } from '../services/delayCause';

const AdvancedSignals = ({ now, issues, forecasts, disruptions, crowding, accessibility, reliability, vehicles, entries, modelHealth }) => {
  const [scenarioLine, setScenarioLine] = useState('U1');
  const [scenarioMinutes, setScenarioMinutes] = useState(15);
  const [causeLine, setCauseLine] = useState('U1');
  const [reports, setReports] = useState(() => getReports(now));
  const [reportForm, setReportForm] = useState({ line: 'U1', station: '', category: 'crowding', severity: 'medium', note: '' });
  const [reportSaved, setReportSaved] = useState(false);
  const eta = useMemo(() => buildEtaUncertainty(vehicles), [vehicles]);
  const transfers = useMemo(() => buildTransferHealth(vehicles, now), [vehicles, now]);
  const recovery = useMemo(() => buildRecoveryForecast({ issues, forecasts, reliability }), [issues, forecasts, reliability]);
  const stations = useMemo(() => buildStationSignals(issues), [issues]);
  const dwell = useMemo(() => buildDwellSignals(vehicles), [vehicles]);
  const direction = useMemo(() => buildDirectionSignals(vehicles), [vehicles]);
  const pressure = useMemo(() => buildCalendarPressure(now, crowding), [now, crowding]);
  const routeRisk = useMemo(() => buildRouteRisk({ recovery, pressure: crowding, reliability }), [recovery, crowding, reliability]);
  const causes = useMemo(() => buildCauseSignals({ line: causeLine, issues, disruptions, crowding, forecasts }), [causeLine, issues, disruptions, crowding, forecasts]);
  const classifiedCauses = useMemo(() => classifyDelayCauses({ line: causeLine, issues, disruptions, reports }), [causeLine, issues, disruptions, reports]);
  const occupancy = useMemo(() => estimateNetworkOccupancy({ now, crowding, issues, vehicles, reports }), [now, crowding, issues, vehicles, reports]);
  const reportSummary = useMemo(() => summariseReports(reports, now), [reports, now]);
  const scenario = useMemo(() => simulateNetworkScenario({ line: scenarioLine, extraMinutes: scenarioMinutes, issues, forecasts }), [scenarioLine, scenarioMinutes, issues, forecasts]);
  const quality = useMemo(() => buildDataQuality({ now, entries, vehicles, sbahnFreshness: getSbahnFreshness(now) }), [now, entries, vehicles]);

  useEffect(() => subscribeReports(setReports), []);
  const submitReport = (event) => {
    event.preventDefault();
    addReport(reportForm, now);
    setReportForm((previous) => ({ ...previous, station: '', note: '' }));
    setReportSaved(true);
    window.setTimeout(() => setReportSaved(false), 2400);
  };

  return <section className="intelligence-section advanced-signals">
    <div className="intelligence-section-title"><Activity size={14} /><strong>Advanced network signals</strong><em>Experimental</em></div>
    <p className="intelligence-note advanced-intro">New inference layers built from public departures, inferred train positions, station topology and this browser’s history. They are estimates, not official control data.</p>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>ETA uncertainty</strong><span>not a single-point promise</span></div>
      {eta.length ? <div className="advanced-list">{eta.slice(0, 5).map((item) => <div className="advanced-row" key={item.id}>
        <i style={{ background: lineColor(item.line) }}>{item.line}</i><div><strong>{item.station || 'next station'}</strong><span>{item.destination}</span></div><b>{item.low}–{item.high} min</b><small>{item.confidence}%</small>
      </div>)}</div> : <p className="advanced-empty">Waiting for live U-Bahn positions.</p>}
      <small className="advanced-caveat">Range uses position uncertainty and feed freshness; it is not GPS ground truth.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Occupancy estimate</strong><span>privacy-preserving proxy</span></div>
      <div className="advanced-line-grid">{occupancy.map((item) => <div key={item.line} title={item.factors.join(' · ') || 'No extra factor'}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong className={`occupancy-${item.level}`}>{item.level.replace('-', ' ')}</strong><span>{item.score}/100 · {item.confidence}% confidence</span></div>)}</div>
      <small className="advanced-caveat">Estimated from service gaps, time-of-day, inferred trains and optional anonymous reports. No passenger counting is performed.</small>
    </div>

    <div className="advanced-card community-report-card">
      <div className="advanced-card-title"><strong><Users size={14} /> Passenger reports</strong><span>{reportSummary.total} active · expires after 6h</span></div>
      <form className="community-report-form" onSubmit={submitReport}>
        <select value={reportForm.line} onChange={(event) => setReportForm({ ...reportForm, line: event.target.value })} aria-label="Line"><option value="">Network</option>{LINES.map((line) => <option key={line}>{line}</option>)}</select>
        <input value={reportForm.station} maxLength={80} placeholder="Station (optional)" onChange={(event) => setReportForm({ ...reportForm, station: event.target.value })} />
        <select value={reportForm.category} onChange={(event) => setReportForm({ ...reportForm, category: event.target.value })} aria-label="Report type">{REPORT_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        <select value={reportForm.severity} onChange={(event) => setReportForm({ ...reportForm, severity: event.target.value })} aria-label="Severity"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select>
        <input value={reportForm.note} maxLength={240} placeholder="Short note (optional)" onChange={(event) => setReportForm({ ...reportForm, note: event.target.value })} />
        <button type="submit"><MapPin size={13} />{reportSaved ? 'Saved' : 'Report'}</button>
      </form>
      {reportSummary.recent.length ? <div className="community-report-list">{reportSummary.recent.slice(0, 4).map((report) => <div key={report.id}><b>{report.line || 'Network'}</b><span>{REPORT_CATEGORIES.find((item) => item.id === report.category)?.label || report.category}{report.station ? ` · ${report.station}` : ''}</span><small>{report.severity}</small></div>)}</div> : <p className="advanced-empty">No passenger reports on this device yet.</p>}
      <small className="advanced-caveat">Reports are anonymous and stored only in this browser. They are advisory, not verified incident reports.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Model monitoring & rollback</strong><span>{modelHealth?.status || 'loading'}</span></div>
      <div className="quality-grid"><span>MAE {modelHealth?.maeMinutes == null ? '—' : `${modelHealth.maeMinutes} min`}</span><span>RMSE {modelHealth?.rmseMinutes == null ? '—' : `${modelHealth.rmseMinutes} min`}</span><span>{modelHealth?.sampleCount || 0} test journeys</span><span>{modelHealth?.ageHours == null ? 'age unknown' : `${modelHealth.ageHours}h old`}</span></div>
      {modelHealth?.rollback ? <div className="advanced-warning"><AlertTriangle size={13} />Predictions are automatically rolled back to the live estimate: {modelHealth.reasons?.join('; ')}</div> : <div className="feed-status live"><ShieldCheck size={14} /><span>{modelHealth?.status === 'healthy' ? 'Model passes deployment checks.' : 'Monitoring is collecting enough evidence.'}</span></div>}
      <small className="advanced-caveat">Rollback disables the ML adjustment without hiding its metrics, so a human can inspect why a candidate was held back.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Passenger route risk</strong><span>risk-aware alternative</span></div>
      <div className="advanced-line-grid">{routeRisk.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong className={`risk-label ${item.level}`}>{item.risk}% risk</strong><span>{item.alternative ? `Check ${item.alternative} as an alternative` : 'No alternative scored'}</span></div>)}</div>
      <small className="advanced-caveat">This ranks service risk, not journey time; compare the alternative route before choosing it.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Transfer health</strong><span>missed-connection risk</span></div>
      {transfers.length ? <div className="advanced-list">{transfers.slice(0, 5).map((item) => <div className="advanced-row" key={`${item.from}-${item.to}-${item.station}`}>
        <i style={{ background: lineColor(item.from) }}>{item.from}</i><div><strong>{item.station} → {item.to}</strong><span>{item.destination}</span></div><b className={item.probability < 50 ? 'risk-high' : ''}>{item.probability}%</b><small>{item.rating}</small>
      </div>)}</div> : <p className="advanced-empty">No transfer estimate available from the current feed.</p>}
      <small className="advanced-caveat">Includes a conservative transfer-time assumption; walking speed and platform conditions are unknown.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Recovery forecast</strong><span>line-level heuristic</span></div>
      <div className="advanced-line-grid">{recovery.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong>{item.window}</strong><span>{item.status} · {item.confidence}% confidence</span></div>)}</div>
      <small className="advanced-caveat">Estimated from current gaps, propagation risk and local history; it is not an operator recovery commitment.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Reliability & station hotspots</strong><span>time-aware evidence</span></div>
      <div className="advanced-line-grid">{reliability.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong>{item.score === null ? 'Learning' : `${item.score}%`}</strong><span>{item.observations} observations</span></div>)}</div>
      {stations.length > 0 && <div className="advanced-hotspots">{stations.slice(0, 3).map((item) => <span key={item.station}>{item.station} · {item.gaps} gaps / {item.bunches} bunches</span>)}</div>}
      <small className="advanced-caveat">Station rows show observed anomaly concentration, not passenger counts or infrastructure failure rates.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Calendar-aware crowd outlook</strong><span>pressure proxy</span></div>
      <div className="advanced-line-grid">{pressure.map((item) => <div key={item.line}><i style={{ background: lineColor(item.line) }}>{item.line}</i><strong>{item.outlook}</strong><span>{item.level} · {item.source}</span></div>)}</div>
      <small className="advanced-caveat">No event-ticket or passenger-count feed is available; this combines time-of-week and service-pattern signals.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Train consistency checks</strong><span>direction & dwell anomalies</span></div>
      {direction.length || dwell.length ? <div className="advanced-list">
        {direction.slice(0, 3).map((item) => <div className="advanced-row" key={`${item.line}-${item.destination}-${item.station}`}><i style={{ background: lineColor(item.line) }}>{item.line}</i><div><strong>Low direction confidence</strong><span>{item.destination} · {item.station}</span></div><b className="risk-high">{item.confidence}%</b><small>{item.direction}</small></div>)}
        {dwell.slice(0, 3).map((item) => <div className="advanced-row" key={`${item.line}-${item.station}`}><i style={{ background: lineColor(item.line) }}>{item.line}</i><div><strong>Possible prolonged dwell</strong><span>{item.station}</span></div><b className="risk-high">{item.minutes} min</b><small>verify</small></div>)}
      </div> : <p className="advanced-empty">No consistency anomaly detected.</p>}
      <small className="advanced-caveat">These are validation flags for inferred positions, not confirmed driver or signaling events.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Step-free route resilience</strong><span>accessibility alternatives</span></div>
      {accessibility.length ? accessibility.slice(0, 4).map((item) => <div className="advanced-impact" key={item.id}><Accessibility size={13} /><div><strong>{item.station}</strong><span>{item.lines.join(' · ') || 'network'} · {item.alternatives.length} alternatives to check</span></div></div>) : <p className="advanced-empty">No current accessibility impact is listed.</p>}
      <small className="advanced-caveat">Alternative stations still require on-site confirmation of step-free access.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Delay-cause evidence</strong><span>explainable signals</span></div>
      <div className="advanced-controls">{LINES.map((line) => <button key={line} onClick={() => setCauseLine(line)} className={causeLine === line ? 'active' : ''} style={{ '--line-color': lineColor(line) }}>{line}</button>)}</div>
      {classifiedCauses.length ? <ul className="advanced-evidence-list">{classifiedCauses.map((item, index) => <li key={`${item.cause}-${item.evidence}-${index}`}><strong>{item.cause}</strong><span>{item.evidence}</span><small>{item.source} · {item.confidence}%</small></li>)}</ul> : causes.length ? <ul className="advanced-evidence-list">{causes.map((item) => <li key={`${item.label}-${item.detail}`}><strong>{item.label}</strong>{item.detail}</li>)}</ul> : <p className="advanced-empty">No causal signal is visible for {causeLine}.</p>}
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Network scenario simulator</strong><span>what-if, not a forecast</span></div>
      <div className="advanced-controls scenario-controls"><label>Line<select value={scenarioLine} onChange={(event) => setScenarioLine(event.target.value)}>{LINES.map((line) => <option key={line}>{line}</option>)}</select></label><label>Extra minutes<input type="number" min="5" max="45" step="5" value={scenarioMinutes} onChange={(event) => setScenarioMinutes(Number(event.target.value))} /></label></div>
      <div className="scenario-output">{scenario.map((item) => <div key={item.minutes}><strong>+{item.minutes} min</strong><span>{item.risk}% propagation risk · {item.lines.join(' · ') || 'no spillover'}</span></div>)}</div>
      <small className="advanced-caveat">This transparent simulation applies a simple sensitivity rule; it does not issue operating instructions.</small>
    </div>

    <div className="advanced-card">
      <div className="advanced-card-title"><strong>Data quality monitor</strong><span>feed confidence</span></div>
      <div className="quality-score"><ShieldCheck size={16} /><strong>{quality.confidence}%</strong><span>usable evidence confidence</span></div>
      <div className="quality-grid"><span>{quality.freshStations}/{quality.totalStations} fresh stations</span><span>{quality.liveArrivals} live predictions</span><span>{quality.liveVehicles} inferred trains</span><span>S-Bahn timetable {quality.sbahn}</span></div>
      {quality.staleEntries > 0 && <div className="advanced-warning"><AlertTriangle size={13} />{quality.staleEntries} station feeds are stale.</div>}
      <small className="advanced-caveat">Use this score to decide whether an estimate needs verification before relying on it.</small>
    </div>

    <p className="intelligence-note"><GitBranch size={12} /> These analytics complement official Wiener Linien and ÖBB information; they do not replace it.</p>
  </section>;
};

export default AdvancedSignals;

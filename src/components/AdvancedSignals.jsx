import React, { useMemo, useState } from 'react';
import { Accessibility, Activity, AlertTriangle, GitBranch, ShieldCheck } from 'lucide-react';
import { lineColor } from '../utils/lineColor';
import { getSbahnFreshness } from '../services/dataFreshness';
import {
  buildCalendarPressure, buildCauseSignals, buildDataQuality, buildDirectionSignals,
  buildDwellSignals, buildEtaUncertainty, buildRecoveryForecast, buildStationSignals,
  buildRouteRisk, buildTransferHealth, simulateNetworkScenario,
} from '../services/advancedIntelligence';
import { LINES } from '../services/transitModels';

const AdvancedSignals = ({ now, issues, forecasts, disruptions, crowding, accessibility, reliability, vehicles, entries }) => {
  const [scenarioLine, setScenarioLine] = useState('U1');
  const [scenarioMinutes, setScenarioMinutes] = useState(15);
  const [causeLine, setCauseLine] = useState('U1');
  const eta = useMemo(() => buildEtaUncertainty(vehicles), [vehicles]);
  const transfers = useMemo(() => buildTransferHealth(vehicles, now), [vehicles, now]);
  const recovery = useMemo(() => buildRecoveryForecast({ issues, forecasts, reliability }), [issues, forecasts, reliability]);
  const stations = useMemo(() => buildStationSignals(issues), [issues]);
  const dwell = useMemo(() => buildDwellSignals(vehicles), [vehicles]);
  const direction = useMemo(() => buildDirectionSignals(vehicles), [vehicles]);
  const pressure = useMemo(() => buildCalendarPressure(now, crowding), [now, crowding]);
  const routeRisk = useMemo(() => buildRouteRisk({ recovery, pressure: crowding, reliability }), [recovery, crowding, reliability]);
  const causes = useMemo(() => buildCauseSignals({ line: causeLine, issues, disruptions, crowding, forecasts }), [causeLine, issues, disruptions, crowding, forecasts]);
  const scenario = useMemo(() => simulateNetworkScenario({ line: scenarioLine, extraMinutes: scenarioMinutes, issues, forecasts }), [scenarioLine, scenarioMinutes, issues, forecasts]);
  const quality = useMemo(() => buildDataQuality({ now, entries, vehicles, sbahnFreshness: getSbahnFreshness(now) }), [now, entries, vehicles]);

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
      {causes.length ? <ul className="advanced-evidence-list">{causes.map((item) => <li key={`${item.label}-${item.detail}`}><strong>{item.label}</strong>{item.detail}</li>)}</ul> : <p className="advanced-empty">No causal signal is visible for {causeLine}.</p>}
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

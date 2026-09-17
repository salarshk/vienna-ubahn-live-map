import React, { useMemo, useState } from 'react';
import { AlertTriangle, GitBranch, SlidersHorizontal, X } from 'lucide-react';
import { simulateNetworkScenario } from '../services/advancedIntelligence';
import { forecastDelayPropagation, LINES } from '../services/transitModels';

const ScenarioSimulator = ({ issues = [], disruptions = [], onClose }) => {
  const [line, setLine] = useState('U1');
  const [extraMinutes, setExtraMinutes] = useState(15);
  const forecasts = useMemo(() => forecastDelayPropagation(issues, disruptions), [issues, disruptions]);
  const scenario = useMemo(() => simulateNetworkScenario({ line, extraMinutes, issues, forecasts }), [line, extraMinutes, issues, forecasts]);
  const activeIssue = issues.find((issue) => issue.line === line);

  return (
    <div className="scenario-simulator-overlay" role="dialog" aria-modal="true" aria-label="Scenario simulator">
      <section className="scenario-simulator">
        <header className="scenario-simulator-header">
          <div className="scenario-simulator-heading">
            <span className="scenario-simulator-kicker"><SlidersHorizontal size={14} /> Decision support · what-if mode</span>
            <h1>Scenario simulator</h1>
            <p>Explore how an additional delay could propagate through connected lines. This is an analytical scenario, not an operating instruction.</p>
          </div>
          <button className="scenario-simulator-icon-button" onClick={onClose} aria-label="Close scenario simulator" title="Close"><X size={18} /></button>
        </header>

        <div className="scenario-simulator-controls">
          <label><span>Impacted line</span><select value={line} onChange={(event) => setLine(event.target.value)}>{LINES.map((lineId) => <option key={lineId}>{lineId}</option>)}</select></label>
          <label className="scenario-simulator-range"><span>Additional delay <b>+{extraMinutes} min</b></span><input type="range" min="5" max="45" step="5" value={extraMinutes} onChange={(event) => setExtraMinutes(Number(event.target.value))} /></label>
          <div className="scenario-simulator-context"><GitBranch size={15} /><span>{activeIssue ? `${activeIssue.label || 'Current irregularity'} · ${activeIssue.station || 'line-wide'}` : `No current ${line} issue; using a conservative baseline.`}</span></div>
        </div>

        <div className="scenario-simulator-results" aria-live="polite">
          {scenario.map((item) => <article className="scenario-simulator-result" key={item.minutes}>
            <div className="scenario-simulator-result-time"><strong>+{item.minutes}</strong><span>minutes</span></div>
            <div className="scenario-simulator-result-main"><div className="scenario-simulator-risk-track"><span style={{ width: `${item.risk}%` }} /></div><strong>{item.risk}% propagation risk</strong><small>{item.lines.length ? `Potentially affected: ${item.lines.join(' · ')}` : 'No connected-line spillover detected'}</small></div>
            <span className={`scenario-simulator-risk-label ${item.risk >= 70 ? 'high' : item.risk >= 40 ? 'medium' : 'low'}`}>{item.risk >= 70 ? 'high' : item.risk >= 40 ? 'watch' : 'low'}</span>
          </article>)}
          {!scenario.length && <div className="scenario-simulator-empty"><AlertTriangle size={20} /><strong>No propagation window available</strong><span>Live forecasts will appear when the network has a current issue or service alert.</span></div>}
        </div>

        <div className="scenario-simulator-notes"><AlertTriangle size={15} /><p>The simulator applies the same transparent propagation logic used by Rail Intelligence. It does not estimate exact train paths, authorize dispatch actions, or replace Wiener Linien control-room decisions.</p></div>
        <footer className="scenario-simulator-footer">Connected-line relationships are based on Vienna U-Bahn interchange topology.</footer>
      </section>
    </div>
  );
};

export default ScenarioSimulator;

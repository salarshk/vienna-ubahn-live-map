import React, { useMemo, useState } from 'react';
import { AlertTriangle, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import arrivalStore from '../services/arrivalStore';
import { lineColor } from '../utils/lineColor';
import {
  advisorIsConfigured, buildRailAdvisorEvidence, requestRailAdvice,
} from '../services/railAdvisor';
import { LINES } from '../services/transitModels';

const STATUS_LABEL = { stable: 'Stable', watch: 'Watch closely', disrupted: 'Disrupted' };
const LINE_STATUS_LABEL = { normal: 'Normal', watch: 'Watch', disrupted: 'Disrupted', unknown: 'Unknown' };
const PRIORITY_LABEL = { low: 'Low priority', medium: 'Medium priority', high: 'High priority' };
const DECISION_LABEL = {
  monitor: 'Monitor',
  verify_headway: 'Verify headway',
  prepare_passenger_message: 'Prepare passenger message',
  review_staffing: 'Review staffing',
  escalate_human_review: 'Escalate for human review',
};

const lineDecisionsForDisplay = (decisions = []) => LINES.map((line) => {
  const decision = decisions.find((item) => item?.line === line);
  return decision || {
    line,
    status: 'unknown',
    priority: 'low',
    decision: 'monitor',
    action: 'Keep this line under routine observation and verify controller telemetry before any intervention.',
    rationale: 'No line-specific decision was returned for this line.',
    evidence: [],
    confidence: 0,
    limitations: 'Public passenger data cannot confirm train-control or track conditions.',
  };
});

const RailAdvisor = ({
  snapshot, disruptions, forecasts, crowding, accessibility,
  delayMetrics, delayPredictions, now,
}) => {
  const [audience, setAudience] = useState('passenger');
  const [goal, setGoal] = useState('');
  const [state, setState] = useState({ status: 'idle', result: null, error: null });
  const configured = advisorIsConfigured();
  const evidence = useMemo(() => buildRailAdvisorEvidence({
    snapshot, disruptions, forecasts, crowding, accessibility, delayMetrics,
    delayPredictions, arrivals: arrivalStore.getNetworkArrivals(now), now,
  }), [snapshot, disruptions, forecasts, crowding, accessibility, delayMetrics, delayPredictions, now]);

  const analyse = async () => {
    setState({ status: 'loading', result: null, error: null });
    try {
      const result = await requestRailAdvice({ audience, goal, evidence });
      setState({ status: 'ready', result, error: null });
    } catch (error) {
      setState({ status: 'error', result: null, error: error.message });
    }
  };

  const advice = state.result?.advice;

  return <section className="intelligence-section rail-advisor">
    <div className="intelligence-section-title"><Sparkles size={14} /><strong>AI rail advisor</strong><em>Experimental</em></div>
    <p className="advisor-intro">Combines current service evidence and model estimates into practical suggestions. It runs only when you ask.</p>
    <div className="advisor-audience" role="group" aria-label="Advice for">
      <button className={audience === 'passenger' ? 'active' : ''} onClick={() => setAudience('passenger')}>Passenger</button>
      <button className={audience === 'operations' ? 'active' : ''} onClick={() => setAudience('operations')}>Operations</button>
    </div>
    <label className="advisor-goal">
      <span>Optional question or goal</span>
      <textarea value={goal} maxLength={240} rows={2} onChange={(event) => setGoal(event.target.value)}
        placeholder={audience === 'passenger' ? 'Example: How can I avoid the most disrupted lines?' : 'Example: Which situation needs attention first?'} />
    </label>
    <button className="advisor-run" onClick={analyse} disabled={!configured || state.status === 'loading'}>
      {state.status === 'loading' ? <LoaderCircle className="advisor-spinner" size={15} />
        : state.status === 'ready' ? <RefreshCw size={15} /> : <Sparkles size={15} />}
      {state.status === 'loading' ? 'Analysing…' : state.status === 'ready' ? 'Analyse again' : 'Analyse live network'}
    </button>

    {!configured && <div className="advisor-unavailable"><AlertTriangle size={15} /><span><strong>AI backend not connected yet</strong>The live map is ready; its secure server still needs an OpenAI key.</span></div>}
    {state.status === 'error' && <div className="advisor-unavailable"><AlertTriangle size={15} /><span><strong>Could not generate advice</strong>{state.error}</span></div>}
    {advice && <div className="advisor-results">
      <div className={`advisor-summary ${advice.networkStatus}`}>
        <span>{STATUS_LABEL[advice.networkStatus] || 'Current assessment'}</span>
        <p>{advice.summary}</p>
      </div>
      {audience === 'operations' && <div className="advisor-line-decisions">
        <div className="advisor-line-decisions-heading">
          <div><strong>Line-by-line control-room decisions</strong><span>Human review required</span></div>
          <p>Decision support from the public feed and model estimates. Confirm with the controller console before acting.</p>
        </div>
        <div className="advisor-line-decision-grid">
          {lineDecisionsForDisplay(advice.lineDecisions).map((lineDecision) => (
            <article className={`advisor-line-decision ${lineDecision.priority || 'low'}`} key={lineDecision.line}>
              <div className="advisor-line-decision-heading">
                <i style={{ background: lineColor(lineDecision.line) }}>{lineDecision.line}</i>
                <div><strong>{DECISION_LABEL[lineDecision.decision] || 'Monitor'}</strong><span>{Math.round((lineDecision.confidence || 0) * 100)}% confidence</span></div>
              </div>
              <div className="advisor-line-decision-meta">
                <span className={`advisor-line-status ${lineDecision.status || 'unknown'}`}>{LINE_STATUS_LABEL[lineDecision.status] || 'Unknown'}</span>
                <span>{PRIORITY_LABEL[lineDecision.priority] || 'Low priority'}</span>
              </div>
              <p className="advisor-action">{lineDecision.action}</p>
              <p className="advisor-rationale">{lineDecision.rationale}</p>
              {lineDecision.evidence?.length > 0 && <ul>{lineDecision.evidence.map((item) => <li key={item}>{item}</li>)}</ul>}
              {lineDecision.limitations && <small>{lineDecision.limitations}</small>}
            </article>
          ))}
        </div>
      </div>}
      {(advice.recommendations || []).map((recommendation, index) => (
        <article className="advisor-card" key={`${recommendation.title}-${index}`}>
          <div className="advisor-card-heading"><strong>{recommendation.title}</strong><span>{Math.round(recommendation.confidence * 100)}% confidence</span></div>
          <p className="advisor-action">{recommendation.action}</p>
          <p className="advisor-rationale">{recommendation.rationale}</p>
          {recommendation.affectedLines?.length > 0 && <div className="advisor-lines">{recommendation.affectedLines.map((line) => (
            <i key={line} style={{ background: lineColor(line) }}>{line}</i>
          ))}</div>}
          {recommendation.evidence?.length > 0 && <ul>{recommendation.evidence.map((item) => <li key={item}>{item}</li>)}</ul>}
          {recommendation.limitations && <small>{recommendation.limitations}</small>}
        </article>
      ))}
      <p className="intelligence-note">Generated by {state.result.model}. Advisory only—verify official notices before relying on it. The app requests concise evidence and rationale, not private model reasoning.</p>
    </div>}
  </section>;
};

export default RailAdvisor;

import React from 'react';
import { Activity, AlertTriangle, Clock3 } from 'lucide-react';
import { lineColor } from '../utils/lineColor';

const minutes = (value) => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(1)} min` : '—';

const DelayTimeline = ({ arrivals = [], now = Date.now(), predictions = [], disruptions = [] }) => {
  const rows = arrivals.filter((arrival) => arrival.isLive && arrival.line?.startsWith('U')).slice(0, 6).map((arrival) => {
    const reported = Number.isFinite(arrival.reportedDelaySeconds) ? arrival.reportedDelaySeconds / 60 : null;
    const prediction = predictions.find((item) => item.line === arrival.line)?.minutes;
    const incident = disruptions.find((item) => item.lines?.includes(arrival.line));
    return { arrival, reported, prediction, incident };
  });
  return <section className="intelligence-section delay-timeline-card">
    <div className="intelligence-section-title"><Activity size={14} /><strong>Delay explanation timeline</strong><em>Evidence chain</em></div>
    {rows.length ? <div className="delay-timeline-list">{rows.map(({ arrival, reported, prediction, incident }, index) => <article className="delay-timeline-row" key={`${arrival.line}-${arrival.destination}-${index}`}>
      <div className="delay-timeline-line"><i style={{ background: lineColor(arrival.line) }}>{arrival.line}</i><span>{arrival.destination}</span></div>
      <div className="delay-timeline-track"><div className="delay-timeline-node"><Clock3 size={11} /><small>planned</small><b>{new Date(arrival.plannedTargetTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b></div><div className="delay-timeline-node"><Activity size={11} /><small>reported</small><b>{minutes(reported)}</b></div><div className="delay-timeline-node"><Activity size={11} /><small>model</small><b>{minutes(prediction)}</b></div></div>
      <div className="delay-timeline-evidence">{incident ? <><AlertTriangle size={11} /> {incident.title}</> : reported !== null ? 'Official timeReal − timePlanned' : 'Live departure estimate'}<small>{Math.max(0, Math.round((arrival.targetTimestamp - now) / 60000))} min until target</small></div>
    </article>)}</div> : <p className="advanced-empty">Waiting for live U-Bahn timing evidence.</p>}
    <p className="intelligence-note">The chain separates the planned time, operator-reported deviation, model estimate and any matching official notice. It does not claim GPS ground truth.</p>
  </section>;
};

export default DelayTimeline;

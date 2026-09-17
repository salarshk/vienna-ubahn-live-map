import React from 'react';
import {
  Activity, BarChart3, BrainCircuit, Clock3, Database, Layers, X,
} from 'lucide-react';
import { lineColor } from '../utils/lineColor';
import PredictionLab from './PredictionLab';

const formatAge = (timestamp, now) => {
  if (!timestamp) return 'not available';
  const seconds = Math.max(0, Math.round((now - Number(timestamp)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
};

const valueOrDash = (value) => value === null || value === undefined || value === '' ? '—' : value;

/**
 * A reader-friendly inventory of the live data fabric and every prediction
 * family. The detailed PredictionLab is intentionally reused here so this
 * dashboard cannot drift away from the outputs shown in Rail Intelligence.
 */
const ModelDashboard = ({
  now,
  snapshot,
  networkSnapshot,
  delaySnapshot,
  operationalModelSnapshot,
  onlineMetrics,
  delayMetrics,
  delayPredictions = [],
  arrivals = [],
  issues = [],
  crowding = [],
  vehicles = [],
  entries = [],
  labTransfers = [],
  labRecovery = [],
  labRouteRisk = [],
  weatherSnapshot,
  mobilitySnapshot,
  disruptions = [],
  onClose,
}) => {
  const shared = networkSnapshot?.data;
  const sharedModels = shared?.models?.predictionLab || {};
  const operationalReport = operationalModelSnapshot?.report;
  const reliability = snapshot?.reliability || [];
  const liveVehicles = vehicles.filter((vehicle) => vehicle.isLive !== false);
  const liveEntries = entries.filter((entry) => now - Number(entry?.fetchedAt || 0) < 5 * 60 * 1000);
  const lineRows = reliability.map((item) => {
    const issueCount = issues.filter((issue) => issue.line === item.line).length;
    const prediction = delayPredictions.find((candidate) => candidate.line === item.line);
    const crowd = crowding.find((candidate) => candidate.line === item.line);
    const score = Number.isFinite(item.score) ? item.score : 0;
    return {
      ...item,
      issueCount,
      prediction,
      crowd,
      score,
    };
  });
  const modelRows = [
    {
      name: 'U-Bahn delay estimation',
      status: delaySnapshot?.status === 'ready' ? (delayMetrics?.validationStage || 'preliminary') : 'collecting',
      detail: delayMetrics?.model ? `MAE ${valueOrDash(delayMetrics.model.maeMinutes)} min · RMSE ${valueOrDash(delayMetrics.model.rmseMinutes)} min` : 'Waiting for labelled journeys',
    },
    {
      name: 'Fast online calibration',
      status: onlineMetrics?.status || 'learning',
      detail: onlineMetrics?.model ? `MAE ${valueOrDash(onlineMetrics.model.maeMinutes)} min · ${valueOrDash(onlineMetrics.scoredJourneyCount)} scored` : 'Prequential score is still collecting',
    },
    {
      name: 'Operational model registry',
      status: operationalReport ? 'loaded' : 'unavailable',
      detail: operationalReport ? `${operationalReport.summary?.candidate || 0} candidates · ${operationalReport.summary?.collectingLabels || 0} collecting labels` : 'Report not loaded',
    },
    {
      name: 'Shared edge inference',
      status: shared?.models ? 'live' : 'local fallback',
      detail: shared?.generatedAt ? `Worker snapshot ${formatAge(shared.generatedAt, now)}` : 'Browser baselines are active',
    },
  ];

  return (
    <div className="model-dashboard-overlay" role="dialog" aria-modal="true" aria-label="Rail intelligence dashboard">
      <section className="model-dashboard">
        <header className="model-dashboard-header">
          <div className="model-dashboard-title">
            <BrainCircuit size={20} />
            <div><strong>Rail intelligence dashboard</strong><span>Models, live evidence, predictions and figures in one view</span></div>
          </div>
          <button className="panel-close-button" onClick={onClose} aria-label="Close dashboard"><X size={18} /></button>
        </header>

        <div className="model-dashboard-scroll">
          <section className="dashboard-hero">
            <div><span className="dashboard-kicker">NETWORK PULSE</span><h2>Vienna rail model room</h2><p>Every value below is labelled as live, inferred, scheduled or experimental so the dashboard never presents a proxy as ground truth.</p></div>
            <div className="dashboard-updated"><Clock3 size={14} /><span>View time<strong>{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</strong></span></div>
          </section>

          <section className="dashboard-stat-grid" aria-label="Current network data">
            <div><Database size={15} /><span>Live trains<strong>{liveVehicles.length}</strong></span></div>
            <div><Activity size={15} /><span>Fresh station feeds<strong>{liveEntries.length}</strong></span></div>
            <div><BarChart3 size={15} /><span>Active warnings<strong>{issues.length + disruptions.length}</strong></span></div>
            <div><Layers size={15} /><span>Prediction families<strong>{Object.keys(sharedModels).length || 'local'}</strong></span></div>
          </section>

          <section className="dashboard-card">
            <div className="dashboard-card-heading"><div><strong>Model health</strong><span>Training state and latest score signals</span></div><BrainCircuit size={16} /></div>
            <div className="dashboard-model-list">{modelRows.map((model) => <div className="dashboard-model-row" key={model.name}><span className={`dashboard-status ${String(model.status).replaceAll(' ', '-')}`}>{model.status}</span><div><strong>{model.name}</strong><small>{model.detail}</small></div></div>)}</div>
          </section>

          <section className="dashboard-card">
            <div className="dashboard-card-heading"><div><strong>Line reliability and risk figure</strong><span>Observed reliability, current delay projection and pressure proxy</span></div><BarChart3 size={16} /></div>
            <div className="dashboard-line-figure">{lineRows.map((item) => <div className="dashboard-line-row" key={item.line}>
              <b style={{ background: lineColor(item.line) }}>{item.line}</b>
              <div className="dashboard-line-bars"><span><i style={{ width: `${item.score}%`, background: lineColor(item.line) }} /></span><small>reliability {Number.isFinite(item.score) ? `${item.score}%` : 'learning'}</small></div>
              <strong>{item.prediction ? `+${Number(item.prediction.minutes).toFixed(1)}m` : '—'}</strong>
              <em>{item.issueCount ? `${item.issueCount} alert${item.issueCount > 1 ? 's' : ''}` : item.crowd?.level || 'steady'}</em>
            </div>)}</div>
            <p className="dashboard-caveat">Reliability is calculated from this device’s observed five-minute history. Delay projections use the published model when it is available.</p>
          </section>

          <section className="dashboard-card">
            <div className="dashboard-card-heading"><div><strong>Data fabric and freshness</strong><span>What is feeding the models right now</span></div><Database size={16} /></div>
            <div className="dashboard-data-grid">
              <div><span>Shared Worker snapshot</span><strong>{shared?.generatedAt ? formatAge(shared.generatedAt, now) : 'not connected'}</strong></div>
              <div><span>Official station data</span><strong>{liveEntries.length ? formatAge(Math.max(...liveEntries.map((entry) => Number(entry.fetchedAt) || 0)), now) : 'not available'}</strong></div>
              <div><span>Weather context</span><strong>{weatherSnapshot?.current?.description || weatherSnapshot?.status || 'waiting'}</strong></div>
              <div><span>Mobility context</span><strong>{mobilitySnapshot?.status || 'local baseline'}</strong></div>
              <div><span>Inferred positions</span><strong>{liveVehicles.filter((vehicle) => vehicle.positionSource !== 'scheduled').length} trains</strong></div>
              <div><span>Headway archive</span><strong>{issues.length ? `${issues.length} active` : 'no active events'}</strong></div>
            </div>
          </section>

          <section className="dashboard-card dashboard-prediction-summary">
            <div className="dashboard-card-heading"><div><strong>Prediction pulse</strong><span>Shared outputs available for downstream decisions</span></div><Activity size={16} /></div>
            <div className="dashboard-pulse-grid">
              <div><span>Delay lines</span><strong>{delayPredictions.length || '—'}</strong><small>current line estimates</small></div>
              <div><span>Headway outlooks</span><strong>{sharedModels.headways?.length || issues.length || '—'}</strong><small>gap and bunching signals</small></div>
              <div><span>ETA forecasts</span><strong>{sharedModels.eta?.length || '—'}</strong><small>next-station predictions</small></div>
              <div><span>Recovery signals</span><strong>{sharedModels.recovery?.length || labRecovery.length || '—'}</strong><small>incident clearance windows</small></div>
              <div><span>Transfers scored</span><strong>{sharedModels.transfers?.length || labTransfers.length || '—'}</strong><small>connection probabilities</small></div>
              <div><span>Route risks</span><strong>{sharedModels.routes?.length || labRouteRisk.length || '—'}</strong><small>alternative recommendations</small></div>
            </div>
          </section>

          <PredictionLab
            now={now}
            issues={issues}
            disruptions={disruptions}
            crowding={crowding}
            reliability={reliability}
            vehicles={vehicles}
            arrivals={arrivals}
            transfers={labTransfers}
            routeRisk={labRouteRisk}
            delayPredictions={delayPredictions}
            weather={weatherSnapshot?.current}
            mobilitySnapshot={mobilitySnapshot}
            networkSnapshot={networkSnapshot}
            operationalModels={operationalReport}
          />
        </div>
      </section>
    </div>
  );
};

export default ModelDashboard;

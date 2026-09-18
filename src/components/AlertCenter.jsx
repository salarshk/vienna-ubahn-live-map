import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, RefreshCw, X } from 'lucide-react';
import { getCommutePreferences } from '../services/commutePreferences';

const timeLabel = (value) => {
  if (!value) return null;
  const parsed = new Date(String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

/** A dedicated, readable service-alert workspace opened from the top bar. */
const AlertCenter = ({ snapshot, selectedAlert, onSelectAlert, onRefresh, onClose }) => {
  const alerts = Array.isArray(snapshot?.alerts) ? snapshot.alerts : [];
  const [scope, setScope] = useState('all');
  const saved = getCommutePreferences().stations || [];
  const savedNames = useMemo(() => new Set(saved.map((station) => String(station.name || '').toLowerCase())), [saved]);
  const savedLines = useMemo(() => new Set(saved.flatMap((station) => station.lines || []).map(String)), [saved]);
  const visibleAlerts = scope === 'saved'
    ? alerts.filter((alert) => {
      const location = String(alert.station || alert.location || '').toLowerCase();
      return (alert.lines || []).some((line) => savedLines.has(String(line)))
        || [...savedNames].some((name) => name && location.includes(name));
    })
    : alerts;

  return (
    <div className="alert-center-overlay" role="dialog" aria-modal="true" aria-label="Service-alert center">
      <section className="alert-center">
        <header className="alert-center-header">
          <div className="alert-center-heading">
            <span className="alert-center-kicker"><AlertTriangle size={14} /> Live service information</span>
            <h1>Service-alert center</h1>
            <p>Official Wiener Linien notices, expanded for quick operational review.</p>
          </div>
          <div className="alert-center-actions">
            <span className={`alert-center-status ${snapshot?.status === 'loading' ? 'loading' : ''}`}>
              {snapshot?.status === 'loading' ? 'Checking…' : snapshot?.lastUpdated ? `Updated ${timeLabel(snapshot.lastUpdated)}` : 'Waiting for feed'}
            </span>
            <button className="alert-center-icon-button" onClick={onRefresh} disabled={snapshot?.status === 'loading'} aria-label="Refresh service alerts" title="Refresh service alerts">
              <RefreshCw size={17} className={snapshot?.status === 'loading' ? 'spin' : ''} />
            </button>
            <button className="alert-center-icon-button" onClick={onClose} aria-label="Close service-alert center" title="Close">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="alert-center-scope" role="group" aria-label="Alert scope">
          <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')} aria-pressed={scope === 'all'}>All network alerts</button>
          <button className={scope === 'saved' ? 'active' : ''} onClick={() => setScope('saved')} aria-pressed={scope === 'saved'} disabled={!saved.length}>My saved lines and stations</button>
          {!saved.length && <small>Save stations in My commute to personalize this view.</small>}
        </div>

        <div className="alert-center-summary" aria-live="polite">
          <div className={visibleAlerts.length ? 'alert-center-summary-icon warning' : 'alert-center-summary-icon ok'}>
            {visibleAlerts.length ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
          </div>
          <div>
            <strong>{visibleAlerts.length ? `${visibleAlerts.length} active service alert${visibleAlerts.length === 1 ? '' : 's'}` : 'No matching alerts'}</strong>
            <span>{scope === 'saved' ? 'Filtered to your saved lines and stations.' : visibleAlerts.length ? 'Tap an alert to see its scope, timing and operator message.' : 'No current U-Bahn disruption is reported by the official feed.'}</span>
          </div>
        </div>

        {snapshot?.error && <p className="alert-center-error" role="alert">{snapshot.error}</p>}

        {visibleAlerts.length > 0 ? (
          <div className="alert-center-list">
            {visibleAlerts.map((alert) => {
              const expanded = selectedAlert?.id === alert.id;
              return (
                <article className={`alert-center-item ${expanded ? 'selected' : ''}`} key={alert.id}>
                  <button className="alert-center-item-toggle" onClick={() => onSelectAlert(expanded ? null : alert)} aria-expanded={expanded}>
                    <span className="alert-center-item-icon"><AlertTriangle size={16} /></span>
                    <span className="alert-center-item-title">
                      <strong>{alert.title}</strong>
                      <span>{alert.station || alert.location || 'Network-wide notice'}</span>
                    </span>
                    <span className="alert-center-item-chevron">{expanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}</span>
                  </button>
                  <div className="alert-center-lines">
                    {(alert.lines || []).map((line) => <span key={line}>{line}</span>)}
                    {alert.status && <em>{alert.status}</em>}
                  </div>
                  {expanded && (
                    <div className="alert-center-detail">
                      {alert.description && <p>{alert.description}</p>}
                      {alert.reason && <p><b>Reason:</b> {alert.reason}</p>}
                      {alert.location && alert.location !== alert.station && <p><b>Location:</b> {alert.location}</p>}
                      {(alert.startsAt || alert.endsAt) && <p><b>Time:</b> {timeLabel(alert.startsAt) || 'now'}{alert.endsAt ? ` – ${timeLabel(alert.endsAt)}` : ''}</p>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="alert-center-empty"><CheckCircle2 size={26} /><strong>No active service alerts</strong><span>The official disruption feed is currently clear.</span></div>
        )}

        <footer className="alert-center-footer">This view reflects the official feed; inferred map predictions remain separate in Rail Intelligence.</footer>
      </section>
    </div>
  );
};

export default AlertCenter;

import React from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, RefreshCw, X } from 'lucide-react';

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

        <div className="alert-center-summary" aria-live="polite">
          <div className={alerts.length ? 'alert-center-summary-icon warning' : 'alert-center-summary-icon ok'}>
            {alerts.length ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
          </div>
          <div>
            <strong>{alerts.length ? `${alerts.length} active service alert${alerts.length === 1 ? '' : 's'}` : 'Network normal'}</strong>
            <span>{alerts.length ? 'Tap an alert to see its scope, timing and operator message.' : 'No current U-Bahn disruption is reported by the official feed.'}</span>
          </div>
        </div>

        {snapshot?.error && <p className="alert-center-error" role="alert">{snapshot.error}</p>}

        {alerts.length > 0 ? (
          <div className="alert-center-list">
            {alerts.map((alert) => {
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

import React from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, RefreshCw, X } from 'lucide-react';

const timeLabel = (value) => {
  if (!value) return null;
  const parsed = new Date(String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

const ServiceAlerts = ({ snapshot, selectedAlert, onSelectAlert, onRefresh, sidebarOpen, isOpen, onOpenChange, onOpen }) => {
  const alerts = snapshot.alerts || [];

  const active = selectedAlert || null;
  const hasAlerts = alerts.length > 0;

  return (
    <section className={`service-alerts ${sidebarOpen ? 'sidebar-open' : ''}`} aria-label="Service information">
      {isOpen && (
        <div className="service-alerts-panel glass-panel">
          <header>
            <div><strong>Service information</strong><span>Wiener Linien</span></div>
            <div className="service-alert-actions">
              <button onClick={onRefresh} aria-label="Refresh service information" disabled={snapshot.status === 'loading'}>
                <RefreshCw size={16} className={snapshot.status === 'loading' ? 'spin' : ''} />
              </button>
              <button onClick={() => { onOpenChange(false); onSelectAlert(null); }} aria-label="Close service information"><X size={17} /></button>
            </div>
          </header>

          {snapshot.error && <p className="service-alert-error">{snapshot.error}</p>}
          {!hasAlerts && !snapshot.error && (
            <div className="service-alert-empty"><CheckCircle2 size={20} /> No current U-Bahn disruptions reported.</div>
          )}
          {hasAlerts && (
            <div className="service-alert-list">
              {alerts.map((alert) => {
                const expanded = active?.id === alert.id;
                return (
                  <button key={alert.id} className={`service-alert-item ${expanded ? 'selected' : ''}`} onClick={() => onSelectAlert(expanded ? null : alert)}>
                    <div className="service-alert-title-row">
                      <AlertTriangle size={16} />
                      <strong>{alert.title}</strong>
                      {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    </div>
                    <div className="service-alert-lines">
                      {alert.lines.map((line) => <span key={line}>{line}</span>)}
                      {alert.station && <span className="service-alert-station">{alert.station}</span>}
                    </div>
                    {expanded && (
                      <div className="service-alert-description">
                        {alert.description && <p>{alert.description}</p>}
                        {alert.status && <p><b>Status:</b> {alert.status}</p>}
                        {alert.location && alert.location !== alert.station && <p><b>Location:</b> {alert.location}</p>}
                        {alert.reason && <p><b>Reason:</b> {alert.reason}</p>}
                        {(alert.startsAt || alert.endsAt) && <p><b>Time:</b> {timeLabel(alert.startsAt) || 'now'}{alert.endsAt ? ` – ${timeLabel(alert.endsAt)}` : ''}</p>}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <button
        className={`service-alert-toggle glass-panel ${hasAlerts ? 'has-alerts' : ''}`}
        onClick={() => {
          if (!isOpen) onOpen?.();
          onOpenChange(!isOpen);
        }}
        aria-expanded={isOpen}
      >
        {hasAlerts ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
        {snapshot.status === 'loading' && !snapshot.lastUpdated ? 'Checking service…' : hasAlerts ? `${alerts.length} service alert${alerts.length === 1 ? '' : 's'}` : 'Network normal'}
      </button>
    </section>
  );
};

export default ServiceAlerts;

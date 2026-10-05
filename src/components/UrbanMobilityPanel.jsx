import React, { useMemo, useState } from 'react';
import { Activity, CalendarDays, CloudRain, RefreshCw, TrafficCone, X } from 'lucide-react';
import { buildUrbanMobilityForecast } from '../services/urbanMobilityModels';
import { mobilityContextStore } from '../services/mobilityContextStore';

const tone = (score) => score >= 70 ? 'high' : score >= 40 ? 'watch' : 'routine';

const UrbanMobilityPanel = ({ snapshot, railRisk = 0, mapVisible = false, onToggleMap, onClose }) => {
  const [refreshing, setRefreshing] = useState(false);
  const forecast = useMemo(() => buildUrbanMobilityForecast({ context: snapshot?.context || {}, railRisk }), [snapshot, railRisk]);
  const trafficSource = snapshot?.sources?.['evis-traffic'];
  const eventSource = snapshot?.sources?.['vienna-events'];
  const trafficStatus = snapshot?.context?.urbanTraffic?.valuesStatus || trafficSource?.status || 'not connected';
  const eventStatus = eventSource?.status || snapshot?.context?.urbanEvents?.status || 'not configured';
  const refresh = async () => {
    setRefreshing(true);
    await mobilityContextStore.refresh({ force: true });
    setRefreshing(false);
  };
  return <section className="urban-mobility-panel glass-panel" role="dialog" aria-label="Vienna urban mobility context">
    <header className="urban-mobility-header">
      <div><TrafficCone size={18} /><div><strong>Urban mobility context</strong><span>Traffic, events and surface-access forecasts</span></div></div>
      <button className="panel-close-button" onClick={onClose} aria-label="Close urban mobility panel"><X size={17} /></button>
    </header>
    <div className="urban-mobility-scroll">
      <div className="urban-mobility-hero"><span>NETWORK CONTEXT</span><strong className={tone(forecast.horizons[1]?.score)}>{forecast.horizons[1]?.score ?? 0}/100</strong><small>{forecast.status === 'baseline' ? 'time-of-day baseline' : 'observed + prior'}</small></div>
      <div className="urban-mobility-cards">
        <div><TrafficCone size={14} /><span>Road pressure<strong>{forecast.traffic.congestionScore}/100</strong><small>{forecast.traffic.observations} measurements · {forecast.traffic.incidents} incidents</small></span></div>
        <div><CalendarDays size={14} /><span>Event pressure<strong>{forecast.events.score}/100</strong><small>{forecast.events.active} active records</small></span></div>
        <div><Activity size={14} /><span>Station pressure<strong>{forecast.stationPressure}/100</strong><small>rail + surface access</small></span></div>
        <div><CloudRain size={14} /><span>Journey risk<strong>{forecast.multimodalRisk}/100</strong><small>fallback margin signal</small></span></div>
      </div>
      <div className="urban-mobility-horizons"><strong>Forecast horizon</strong>{forecast.horizons.map((item) => <div key={item.minutes}><span>{item.minutes} min</span><b className={tone(item.score)}>{item.score}</b><small>{item.label}</small></div>)}</div>
      {forecast.warnings.length > 0 && <div className="urban-mobility-warnings">{forecast.warnings.map((warning) => <p key={warning}>! {warning}</p>)}</div>}
      <div className="urban-mobility-sources"><strong>Evidence and limits</strong>{forecast.evidence.map((item) => <span key={item}>• {item}</span>)}<small>{forecast.limitations}</small></div>
      <div className="urban-mobility-feed-status" aria-label="External feed status"><span>Traffic values: <b>{trafficStatus}</b></span><span>Events: <b>{eventStatus}</b></span></div>
      <div className="urban-mobility-actions"><button onClick={onToggleMap} aria-pressed={mapVisible}><TrafficCone size={13} />{mapVisible ? 'Hide map signals' : 'Show map signals'}</button><button onClick={refresh} disabled={refreshing}><RefreshCw size={13} className={refreshing ? 'spin' : ''} />{refreshing ? 'Refreshing…' : 'Refresh context'}</button></div>
      <div className="urban-mobility-footnote">Updated {snapshot?.updatedAt ? new Date(snapshot.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'not yet'} · counter locations are public metadata; measured speeds and event pressure require configured Worker feeds.</div>
    </div>
  </section>;
};

export default UrbanMobilityPanel;

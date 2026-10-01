import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Clock3, Radio, TrainFront, X } from 'lucide-react';
import { lineColor } from '../utils/lineColor';

const SAMPLE_LIMIT = 36;

const classifyLine = (line) => {
  const id = String(line || '').trim().toUpperCase();
  if (id.startsWith('U')) return 'ubahn';
  if (id.startsWith('S') || id === 'CAT' || id.includes('AIRPORT')) return 'sbahn';
  return 'tram';
};

const CATEGORY_META = {
  ubahn: { label: 'U-Bahn', color: '#80a8ff' },
  sbahn: { label: 'S-Bahn / CAT', color: '#a7adb8' },
  tram: { label: 'Tram', color: '#ffb74d' },
};

const formatClock = (timestamp) => new Date(timestamp || Date.now()).toLocaleTimeString([], {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const formatAge = (seconds) => {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 1) return '<1s';
  return `${Math.round(seconds)}s`;
};

const sampleFrom = (vehicles, alerts, at) => {
  const list = Array.isArray(vehicles) ? vehicles : [];
  const live = list.filter((vehicle) => vehicle.isLive);
  const fresh = live.filter((vehicle) => Number(vehicle.lastDataAgeSeconds) <= 3);
  return {
    at,
    trains: list.length,
    live: live.length,
    fresh: fresh.length,
    alerts: Array.isArray(alerts) ? alerts.length : 0,
  };
};

/**
 * A Vienna adaptation of the video's animated all-trains view. It deliberately
 * reports only the data that is currently in the map and labels its chart as a
 * session pulse: no historical service count is invented before this panel is
 * opened.
 */
const ViennaNetworkPulse = ({ vehicles = [], alerts = [], updatedAt = Date.now(), onClose }) => {
  const latestVehiclesRef = useRef(vehicles);
  const latestAlertsRef = useRef(alerts);
  const latestTimeRef = useRef(updatedAt);
  const [samples, setSamples] = useState(() => (updatedAt ? [sampleFrom(vehicles, alerts, updatedAt)] : []));
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    latestVehiclesRef.current = vehicles;
    latestAlertsRef.current = alerts;
    latestTimeRef.current = updatedAt;

    // App receives the first live snapshot asynchronously. Capture that
    // snapshot immediately instead of leaving the panel on its initial empty
    // placeholder until the next five-second interval.
    if (!updatedAt) return;
    const next = sampleFrom(vehicles, alerts, updatedAt);
    setSamples((previous) => {
      const last = previous[previous.length - 1];
      if (last && next.at <= last.at) return previous;
      const bounded = [...previous, next].slice(-SAMPLE_LIMIT);
      setCursor(bounded.length - 1);
      return bounded;
    });
  }, [vehicles, alerts, updatedAt]);

  useEffect(() => {
    const capture = () => {
      const next = sampleFrom(latestVehiclesRef.current, latestAlertsRef.current, latestTimeRef.current || Date.now());
      setSamples((previous) => {
        const last = previous[previous.length - 1];
        if (last && next.at - last.at < 2500) return previous;
        const bounded = [...previous, next].slice(-SAMPLE_LIMIT);
        setCursor(bounded.length - 1);
        return bounded;
      });
    };
    const timer = setInterval(capture, 5000);
    return () => clearInterval(timer);
  }, []);

  const list = Array.isArray(vehicles) ? vehicles : [];
  const live = useMemo(() => list.filter((vehicle) => vehicle.isLive), [list]);
  const fresh = useMemo(() => live.filter((vehicle) => Number(vehicle.lastDataAgeSeconds) <= 3), [live]);
  const lines = useMemo(() => [...new Set(list.map((vehicle) => String(vehicle.line || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [list]);
  const categories = useMemo(() => Object.keys(CATEGORY_META).map((id) => ({
    id,
    ...CATEGORY_META[id],
    count: list.filter((vehicle) => classifyLine(vehicle.line) === id).length,
  })), [list]);
  const meanAge = useMemo(() => {
    const ages = live.map((vehicle) => Number(vehicle.lastDataAgeSeconds)).filter(Number.isFinite);
    return ages.length ? ages.reduce((sum, age) => sum + age, 0) / ages.length : null;
  }, [live]);
  const maxTrains = Math.max(1, ...samples.map((sample) => sample.trains));
  const selectedSample = samples[Math.min(cursor, Math.max(0, samples.length - 1))] || sampleFrom(list, alerts, updatedAt);

  return (
    <section className="vienna-network-pulse" role="dialog" aria-label="Vienna live network pulse">
      <div className="vienna-pulse-card">
        <header className="vienna-pulse-header">
          <div className="vienna-pulse-heading">
            <span className="vienna-pulse-kicker"><Radio size={13} /> Vienna · live rail pulse</span>
            <h2>Every service in motion</h2>
            <p>Wiener Linien and ÖBB positions currently visible on the map.</p>
          </div>
          <button className="vienna-pulse-close" onClick={onClose} aria-label="Close Vienna network pulse" title="Close pulse"><X size={17} /></button>
        </header>

        <div className="vienna-pulse-clock"><Clock3 size={16} /><strong>{formatClock(updatedAt)}</strong><span>Europe/Vienna</span></div>

        <div className="vienna-pulse-stats">
          <div><TrainFront size={16} /><span>Trains in view</span><strong>{list.length}</strong></div>
          <div><Activity size={16} /><span>Live positions</span><strong>{live.length}</strong></div>
          <div className="fresh"><span>●</span><span>Fresh under 3s</span><strong>{fresh.length}</strong></div>
          <div><span className="vienna-pulse-stat-mark">L</span><span>Active lines</span><strong>{lines.length}</strong></div>
        </div>

        <div className="vienna-pulse-section">
          <div className="vienna-pulse-section-title"><strong>Network mix</strong><span>{meanAge === null ? 'No age signal' : `mean feed age ${formatAge(meanAge)}`}</span></div>
          <div className="vienna-pulse-legend">
            {categories.map((category) => <span key={category.id}><i style={{ background: category.color }} />{category.label}<b>{category.count}</b></span>)}
          </div>
          <div className="vienna-pulse-lines" aria-label="Active Vienna lines">
            {lines.slice(0, 18).map((line) => <span key={line} style={{ borderColor: lineColor(line), color: lineColor(line) }}>{line}</span>)}
            {lines.length > 18 && <small>+{lines.length - 18} more</small>}
            {!lines.length && <small>No vehicle lines in the current feed.</small>}
          </div>
        </div>
      </div>

      <div className="vienna-pulse-section vienna-pulse-chart-section">
        <div className="vienna-pulse-section-title"><strong>Trains in service</strong><span>{formatClock(selectedSample.at)} · {selectedSample.trains} visible</span></div>
        <div className="vienna-pulse-chart" aria-label="Train count captured during this session">
          {samples.map((sample, index) => <button key={`${sample.at}-${index}`} className={index === cursor ? 'active' : ''} style={{ height: `${Math.max(8, (sample.trains / maxTrains) * 100)}%` }} onClick={() => setCursor(index)} aria-label={`${sample.trains} trains at ${formatClock(sample.at)}`} />)}
        </div>
        <input className="vienna-pulse-slider" type="range" min="0" max={Math.max(0, samples.length - 1)} value={Math.min(cursor, Math.max(0, samples.length - 1))} onChange={(event) => setCursor(Number(event.target.value))} aria-label="Session pulse timeline" />
        <div className="vienna-pulse-chart-scale"><span>{formatClock(samples[0]?.at || updatedAt)}</span><span>now {formatClock(updatedAt)}</span></div>
        <p className="vienna-pulse-note">The timeline starts when this pulse is opened and records one sample every five seconds. It is a live session trace, not backfilled historical data.</p>
      </div>
    </section>
  );
};

export default ViennaNetworkPulse;

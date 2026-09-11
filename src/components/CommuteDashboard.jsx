import React, { useEffect, useMemo, useState } from 'react';
import { Bell, BellOff, Clock3, MapPin, Plus, Star, Trash2, X } from 'lucide-react';
import arrivalStore from '../services/arrivalStore';
import { getStationFocus } from '../services/stationFocus';
import { STATIONS } from '../services/userLocation';
import { lineColor } from '../utils/lineColor';
import { getCommutePreferences, removeCommuteStation, saveCommuteStation } from '../services/commutePreferences';
import { enableDisruptionNotifications, notificationState, disableDisruptionNotifications } from '../services/notifications';

const uniqueStations = [...new Map(STATIONS.map((station) => [station.properties.name, station])).values()]
  .sort((a, b) => a.properties.name.localeCompare(b.properties.name));

const CommuteDashboard = ({ now = Date.now(), onClose, onSelectStation, onPreferencesChange }) => {
  const [preferences, setPreferences] = useState(getCommutePreferences);
  const [stationName, setStationName] = useState('');
  const [notification, setNotification] = useState(notificationState);
  const [, refresh] = useState(0);
  const selectedStations = useMemo(() => preferences.stations.map((saved) => uniqueStations.find((station) => station.properties.name === saved.name)).filter(Boolean), [preferences]);

  useEffect(() => {
    const update = () => refresh((value) => value + 1);
    const unsubscribe = arrivalStore.subscribe(update);
    const timer = setInterval(update, 30000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, []);

  const updatePreferences = (next) => {
    setPreferences(next);
    onPreferencesChange?.(next);
  };

  const addStation = () => {
    const station = uniqueStations.find((item) => item.properties.name === stationName);
    if (!station) return;
    arrivalStore.getStationArrivals(station.properties);
    updatePreferences(saveCommuteStation(station));
    setStationName('');
  };

  const toggleNotifications = async () => {
    const next = notification.enabled ? disableDisruptionNotifications() : await enableDisruptionNotifications();
    setNotification(next);
    updatePreferences(getCommutePreferences());
  };

  return <aside className="glass-panel commute-dashboard" aria-label="My commute dashboard">
    <header><div><strong><Star size={16} /> My commute</strong><span>Saved on this device</span></div><button onClick={onClose} aria-label="Close commute dashboard"><X size={16} /></button></header>
    <p className="commute-intro">Save up to four stations for a quick morning or evening check.</p>
    <div className="commute-add"><input list="commute-stations" value={stationName} placeholder="Search a station" onChange={(event) => setStationName(event.target.value)} /><datalist id="commute-stations">{uniqueStations.map((station) => <option key={station.properties.name} value={station.properties.name} />)}</datalist><button onClick={addStation} disabled={!stationName}><Plus size={14} /> Add</button></div>
    <div className="commute-cards">{selectedStations.length ? selectedStations.map((station) => {
      const focus = getStationFocus(station.properties, now);
      return <article className="commute-card" key={station.properties.name}>
        <header><button onClick={() => onSelectStation(station)}><MapPin size={13} /><strong>{station.properties.name}</strong></button><button onClick={() => updatePreferences(removeCommuteStation(station.properties.name))} aria-label={`Remove ${station.properties.name}`}><Trash2 size={13} /></button></header>
        <div className="commute-lines">{(station.properties.lines || []).map((line) => <i key={line} style={{ background: lineColor(line) }}>{line}</i>)}</div>
        {focus.arrivals.slice(0, 3).map((arrival, index) => <div className="commute-arrival" key={`${arrival.line}-${arrival.destination}-${index}`}><b style={{ background: lineColor(arrival.line) }}>{arrival.line}</b><span>{arrival.destination}</span><strong>{arrival.minutes <= 0 ? 'now' : `${arrival.minutes} min`}</strong></div>)}
        {!focus.arrivals.length && <small>Waiting for departures…</small>}
      </article>;
    }) : <div className="commute-empty">No saved stations yet.</div>}</div>
    <button className={`commute-notification ${notification.enabled ? 'enabled' : ''}`} onClick={toggleNotifications} disabled={!notification.supported}><span>{notification.enabled ? <Bell size={14} /> : <BellOff size={14} />} {notification.enabled ? 'Disruption notifications on' : 'Turn on disruption notifications'}</span><small>{notification.supported ? (notification.permission === 'denied' ? 'Enable in browser settings' : 'Opt in anytime') : 'Not supported here'}</small></button>
    <p className="commute-caveat"><Clock3 size={12} /> Notifications are based on official service messages and only run when you opt in.</p>
  </aside>;
};

export default CommuteDashboard;

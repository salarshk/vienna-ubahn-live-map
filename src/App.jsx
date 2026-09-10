import React, { useState, useEffect } from 'react';
import MapView from './components/MapView';
import Sidebar from './components/Sidebar';
import SearchBar from './components/SearchBar';
import StationPanel from './components/StationPanel';
import VehiclePanel from './components/VehiclePanel';
import ServiceAlerts from './components/ServiceAlerts';
import DashboardBoard from './components/DashboardBoard';
import LocateButton from './components/LocateButton';
import RailIntelligence from './components/RailIntelligence';
import { locate } from './services/userLocation';
import arrivalStore from './services/arrivalStore';
import trainPositionEngine from './services/trainPositionEngine';
import disruptionStore, { REFRESH_INTERVAL_MS as DISRUPTION_REFRESH_MS } from './services/disruptionStore';
import networkIntelligenceStore from './services/networkIntelligence';
import officialSnapshotStore from './services/officialSnapshotStore';
import { lineColor } from './utils/lineColor';
import { Activity, Sun, Moon, X, LayoutDashboard, Menu } from 'lucide-react';
import './index.css';

// How long a locate's answer stays on screen. Long enough to read a refusal,
// short enough that it is gone before it becomes furniture.
const LOCATE_NOTICE_MS = 6000;

// Dashboard mode is bookmarkable so an unattended tablet can boot straight into
// it, and reachable from a button so it is discoverable from the map.
const readMode = () =>
  new URLSearchParams(window.location.search).get('mode') === 'dashboard' ? 'dashboard' : 'map';

function App() {
  const [theme, setTheme] = useState('dark');
  const [mode, setMode] = useState(readMode);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [selectedStation, setSelectedStation] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [selectedAlert, setSelectedAlert] = useState(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [intelligenceOpen, setIntelligenceOpen] = useState(false);
  const [replayOffset, setReplayOffset] = useState(0);
  const [intelligenceSnapshot, setIntelligenceSnapshot] = useState(
    networkIntelligenceStore.getSnapshot()
  );
  const [officialSnapshotState, setOfficialSnapshotState] = useState(
    officialSnapshotStore.getSnapshot()
  );
  const [flyTarget, setFlyTarget] = useState(null);
  const [activeLineFilter, setActiveLineFilter] = useState([]);
  const [hoverLine, setHoverLine] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [locateState, setLocateState] = useState('idle');
  const [locateNotice, setLocateNotice] = useState(null);
  const [mapVisibility, setMapVisibility] = useState({
    ubahnLines: true,
    sbahnLines: true,
    liveTrains: true,
    scheduledTrains: true,
    confidenceRanges: true,
    reliabilityAtlas: false,
  });
  const [disruptionSnapshot, setDisruptionSnapshot] = useState(disruptionStore.getSnapshot());

  useEffect(() => {
    const unsubscribe = disruptionStore.subscribe(setDisruptionSnapshot);
    disruptionStore.refresh();
    const refresh = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      disruptionStore.refresh();
    };
    const timer = setInterval(refresh, DISRUPTION_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  useEffect(() => {
    const record = () => networkIntelligenceStore.record();
    const unsubscribeIntelligence = networkIntelligenceStore.subscribe(setIntelligenceSnapshot);
    const unsubscribeArrivals = arrivalStore.subscribe(record);
    record();
    const timer = setInterval(record, 30000);
    return () => {
      unsubscribeIntelligence();
      unsubscribeArrivals();
      clearInterval(timer);
    };
  }, []);

  // Keep a compact, browser-local audit trail of the operator's official
  // departure predictions. The timer is intentionally more frequent than the
  // ten-minute archive cadence so a background-tab wake-up or a visibility
  // change can capture the next eligible sample without a second API poll.
  useEffect(() => {
    const record = () => {
      officialSnapshotStore.record();
      setOfficialSnapshotState(officialSnapshotStore.getSnapshot());
    };
    const unsubscribe = officialSnapshotStore.subscribe(setOfficialSnapshotState);
    record();
    const timer = setInterval(record, 30000);
    document.addEventListener('visibilitychange', record);
    return () => {
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', record);
    };
  }, []);

  // Live train counts for the sidebar stats panel. Recomputed on every
  // arrivalStore notification so the numbers stay in sync with the map.
  const [trainStats, setTrainStats] = useState({ live: 0, confirmed: 0, scheduled: 0 });
  useEffect(() => {
    const computeStats = () => {
      const vehicles = trainPositionEngine.getAllVehicles(Date.now());
      const live = vehicles.filter((vehicle) => vehicle.isLive);
      setTrainStats({
        live: live.length,
        confirmed: live.filter(v => v.sightingCount > 1).length,
        scheduled: vehicles.filter((vehicle) => vehicle.isScheduled).length,
      });
    };
    computeStats();
    const unsubscribe = arrivalStore.subscribe(computeStats);
    const timer = setInterval(computeStats, 30000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, []);


  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  // Station click — just opens the detail card, does NOT move the map
  const handleSelectStation = (station) => {
    setSelectedVehicle(null);
    setSelectedAlert(null);
    setAlertsOpen(false);
    setIntelligenceOpen(false);
    setSelectedStation(station);
  };

  const handleSelectVehicle = (vehicle) => {
    setSelectedStation(null);
    setSelectedAlert(null);
    setAlertsOpen(false);
    setIntelligenceOpen(false);
    setSelectedVehicle(vehicle);
  };

  const handleSelectAlert = (alert) => {
    if (alert) {
      setSelectedStation(null);
      setSelectedVehicle(null);
      setAlertsOpen(true);
      setIntelligenceOpen(false);
      setReplayOffset(0);
    }
    setSelectedAlert(alert);
  };

  // "Center Station on Map" button — explicitly flies to station
  const handleCenterStation = (station) => {
    // Use a new object each time to force the useEffect to re-fire
    // even if the same station is clicked again
    setFlyTarget({ ...station, _ts: Date.now() });
  };

  // The locate button. One press takes a fix, frames it against the Nearest
  // Station and opens that Station's departures — deliberately compounding the
  // three, against the rule three lines above that a Station click never moves
  // the map. That rule is about incidental clicks; this is a single explicit
  // ask, and answering "where am I" without moving the map would answer
  // nothing. It is the only exception.
  const handleLocate = async () => {
    // A press while a fix is in flight is ignored rather than queued.
    if (locateState === 'locating') return;

    setLocateState('locating');
    // Always re-acquire rather than re-centring on the fix already held: a dot
    // that is twenty minutes old under a button that looks like it just worked
    // is exactly the lie the fade exists to prevent. `maximumAge` inside
    // locate() makes a repeat press within half a minute cheap anyway.
    const result = await locate();

    // A timeout goes back to idle rather than sticking on 'unavailable': it is
    // the one failure worth pressing again, and a crossed-out icon says the
    // opposite. Denied and unavailable are states of the device, not of the
    // attempt, so those persist until something changes.
    setLocateState(
      result.status === 'located' || result.status === 'timeout' ? 'idle' : 'unavailable'
    );
    setUserLocation(result.status === 'located' ? result : null);
    setLocateNotice({ text: result.message, _ts: Date.now() });
    if (result.nearestStation) setSelectedStation(result.nearestStation);
  };

  // Holding the locate button clears the dot. The fix is a snapshot that goes
  // stale on its own — the fade says so — and once it has served its purpose
  // there was previously no way to take it off the map short of a reload.
  const handleHideLocation = () => {
    if (!userLocation) return;
    setUserLocation(null);
    setLocateState('idle');
    setLocateNotice({ text: 'Location hidden.', _ts: Date.now() });
  };

  useEffect(() => {
    if (!locateNotice) return undefined;
    const id = setTimeout(() => setLocateNotice(null), LOCATE_NOTICE_MS);
    return () => clearTimeout(id);
  }, [locateNotice]);

  const handleSelectLine = (lineId) => {
    // null clears selection
    if (!lineId) return setActiveLineFilter([]);
    setActiveLineFilter((prev) => {
      if (!Array.isArray(prev)) prev = [];
      if (prev.includes(lineId)) return prev.filter(l => l !== lineId);
      return [...prev, lineId];
    });
  };

  // Get the active line color for the filter banner
  const getLineColor = (lineId) => {
    return lineColor(lineId);
  };

  const selectMode = (next) => {
    const url = new URL(window.location.href);
    if (next === 'dashboard') url.searchParams.set('mode', 'dashboard');
    else url.searchParams.delete('mode');
    window.history.replaceState({}, '', url);
    setMode(next);
  };

  const replaySnapshot = replayOffset > 0
    ? networkIntelligenceStore.getReplaySnapshot(replayOffset)
    : null;
  const officialReplaySnapshot = replayOffset > 0
    ? officialSnapshotStore.getAtOffset(replayOffset)
    : officialSnapshotStore.getAtOffset(0);

  const openIntelligence = () => {
    setSelectedStation(null);
    setSelectedVehicle(null);
    setSelectedAlert(null);
    setAlertsOpen(false);
    setIntelligenceOpen((open) => !open);
  };

  const closeIntelligence = () => {
    setIntelligenceOpen(false);
    setReplayOffset(0);
  };

  // Back and forward have to land on the mode the URL names, or a bookmarked
  // dashboard stops being a reliable place to return to.
  useEffect(() => {
    const onPopState = () => setMode(readMode());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  if (mode === 'dashboard') {
    return (
      <div className="app-container">
        <DashboardBoard theme={theme} onExit={() => selectMode('map')} />
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Full-screen interactive map */}
      <MapView
        theme={theme}
        selectedStation={selectedStation}
        flyTarget={flyTarget}
        onSelectStation={handleSelectStation}
        activeLineFilter={activeLineFilter}
        hoverLine={hoverLine}
        userLocation={userLocation}
        mapVisibility={mapVisibility}
        disruptions={disruptionSnapshot.alerts}
        onSelectDisruption={handleSelectAlert}
        onSelectVehicle={handleSelectVehicle}
        replaySnapshot={replaySnapshot}
        reliabilityScores={intelligenceSnapshot.reliability}
      />

      {/* Collapsible Sidebar */}
      <Sidebar
        isOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        activeLineFilter={activeLineFilter}
        onSelectLine={handleSelectLine}
        onHoverLine={(lineId) => setHoverLine(lineId)}
        trainStats={trainStats}
        mapVisibility={mapVisibility}
        onToggleVisibility={(key) => setMapVisibility((previous) => ({ ...previous, [key]: !previous[key] }))}
      />

      {/* Top Navigation Bar: Sidebar Toggle Button + Search Bar & Quick Actions */}
      <div className={`top-bar-container ${isSidebarOpen ? 'sidebar-open' : 'sidebar-collapsed'}`}>
        <button
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="sidebar-toggle-btn glass-panel"
          title={isSidebarOpen ? "Close Sidebar" : "Open Sidebar"}
          aria-label={isSidebarOpen ? "Close Sidebar" : "Open Sidebar"}
        >
          <Menu size={20} />
        </button>
        <div
          className="search-bar-container glass-panel"
          style={{ padding: '8px 14px', display: 'flex', gap: '10px', alignItems: 'center' }}
        >
          <SearchBar
            onSelectStation={handleSelectStation}
            onSelectLine={handleSelectLine}
            activeLineFilter={activeLineFilter}
          />
          <div style={{ width: '1px', height: '24px', background: 'var(--border-color)', flexShrink: 0 }} />
          <button
            onClick={() => selectMode('dashboard')}
            style={{
              padding: '8px',
              borderRadius: '8px',
              background: 'var(--bg-hover)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
            title="Dashboard mode — a departure board for an ambient display"
          >
            <LayoutDashboard size={18} />
          </button>
          <button
            onClick={openIntelligence}
            className={intelligenceOpen ? 'top-action-active' : ''}
            style={{
              padding: '8px', borderRadius: '8px', background: 'var(--bg-hover)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
            title="Rail intelligence, replay and reliability"
            aria-label="Open rail intelligence"
            aria-pressed={intelligenceOpen}
          >
            <Activity size={18} color={intelligenceOpen ? '#4CAF50' : undefined} />
          </button>
          <button
            onClick={toggleTheme}
            style={{
              padding: '8px',
              borderRadius: '8px',
              background: 'var(--bg-hover)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
            title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
          >
            {theme === 'dark'
              ? <Sun size={18} color="#FFD100" />
              : <Moon size={18} color="#004D99" />}
          </button>
        </div>
      </div>


      {/* Active Line Filter Banner */}
      {Array.isArray(activeLineFilter) && activeLineFilter.length > 0 && (
        <button
          className="active-filter-banner glass-panel"
          onClick={() => handleSelectLine(null)}
          style={{
            color: '#fff',
            background: getLineColor(activeLineFilter[0]),
            borderColor: 'transparent',
          }}
          title="Click to clear filter"
        >
          <span>Lines {activeLineFilter.join(', ')} only</span>
          <X size={13} style={{ opacity: 0.85 }} />
        </button>
      )}

      {/* What the locate button found, or why it found nothing */}
      {locateNotice && (
        <button
          className="locate-notice glass-panel"
          onClick={() => setLocateNotice(null)}
          title="Dismiss"
        >
          {locateNotice.text}
        </button>
      )}

      {replaySnapshot && !intelligenceOpen && (
        <button className="replay-active-banner glass-panel" onClick={() => setReplayOffset(0)}>
          Replaying {new Date(replaySnapshot.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · return live
        </button>
      )}

      <LocateButton
        state={locateState}
        lifted={Boolean(selectedStation || selectedVehicle)}
        showingLocation={Boolean(userLocation)}
        onLocate={handleLocate}
        onHide={handleHideLocation}
      />

      {/* Station Focus panel — right in landscape, bottom in portrait */}
      {selectedStation && (
        <StationPanel
          station={selectedStation}
          theme={theme}
          userLocation={userLocation}
          onClose={() => setSelectedStation(null)}
          onCenter={() => handleCenterStation(selectedStation)}
        />
      )}

      {selectedVehicle && (
        <VehiclePanel key={selectedVehicle.id} vehicle={selectedVehicle} onClose={() => setSelectedVehicle(null)} />
      )}

      {intelligenceOpen && (
        <RailIntelligence
          snapshot={intelligenceSnapshot}
          disruptions={disruptionSnapshot.alerts}
          replayOffset={replayOffset}
          replaySnapshot={replaySnapshot}
          officialSnapshotState={officialSnapshotState}
          officialReplaySnapshot={officialReplaySnapshot}
          onReplayChange={setReplayOffset}
          atlasVisible={mapVisibility.reliabilityAtlas}
          onToggleAtlas={() => setMapVisibility((previous) => ({
            ...previous,
            reliabilityAtlas: !previous.reliabilityAtlas,
          }))}
          onClose={closeIntelligence}
        />
      )}

      <ServiceAlerts
        snapshot={disruptionSnapshot}
        selectedAlert={selectedAlert}
        onSelectAlert={handleSelectAlert}
        onRefresh={() => disruptionStore.refresh()}
        sidebarOpen={isSidebarOpen}
        isOpen={alertsOpen}
        onOpenChange={setAlertsOpen}
        onOpen={() => {
          setSelectedStation(null);
          setSelectedVehicle(null);
          setIntelligenceOpen(false);
          setReplayOffset(0);
        }}
      />
    </div>
  );
}

export default App;

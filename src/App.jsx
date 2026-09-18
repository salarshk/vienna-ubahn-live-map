import React, { useState, useEffect, useRef } from 'react';
import MapView from './components/MapView';
import Sidebar from './components/Sidebar';
import SearchBar from './components/SearchBar';
import StationPanel from './components/StationPanel';
import VehiclePanel from './components/VehiclePanel';
import LocateButton from './components/LocateButton';
import RailIntelligence from './components/RailIntelligence';
import NearbyStations from './components/NearbyStations';
import CommuteDashboard from './components/CommuteDashboard';
import FleetTracker from './components/FleetTracker';
import AlertCenter from './components/AlertCenter';
import StationDeparturesHub from './components/StationDeparturesHub';
import ScenarioSimulator from './components/ScenarioSimulator';
import { locate, resultFromPosition, watchDeviceLocation } from './services/userLocation';
import arrivalStore from './services/arrivalStore';
import trainPositionEngine from './services/trainPositionEngine';
import { findVehicleForArrival } from './services/vehicleSelection';
import disruptionStore, { REFRESH_INTERVAL_MS as DISRUPTION_REFRESH_MS } from './services/disruptionStore';
import networkIntelligenceStore from './services/networkIntelligence';
import officialSnapshotStore from './services/officialSnapshotStore';
import delayReportStore from './services/delayReportStore';
import { buildCellIntelligence } from './services/gridIntelligence';
import CellDetailPanel from './components/CellDetailPanel';
import { networkSnapshotStore, NETWORK_SNAPSHOT_INTERVAL_MS } from './services/networkSnapshotStore';
import { mobilityContextStore } from './services/mobilityContextStore';
import { notificationState, notifyDisruption } from './services/notifications';
import { lineColor } from './utils/lineColor';
import { Activity, Sun, Moon, X, TrainFront, Menu, Download, Navigation2, Star, RefreshCw, BellRing, MapPinned, Route, Clock3 } from 'lucide-react';
import './index.css';

// How long a locate's answer stays on screen. Long enough to read a refusal,
// short enough that it is gone before it becomes furniture.
const LOCATE_NOTICE_MS = 6000;

function App() {
  const [theme, setTheme] = useState('dark');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [selectedStation, setSelectedStation] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [selectedCell, setSelectedCell] = useState(null);
  const [selectedAlert, setSelectedAlert] = useState(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [intelligenceOpen, setIntelligenceOpen] = useState(false);
  const [intelligenceInitialTab, setIntelligenceInitialTab] = useState('forecast');
  const [fleetTrackerOpen, setFleetTrackerOpen] = useState(false);
  const [alertCenterOpen, setAlertCenterOpen] = useState(false);
  const [stationHubOpen, setStationHubOpen] = useState(false);
  const [scenarioSimulatorOpen, setScenarioSimulatorOpen] = useState(false);
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
    // Trams are available as an opt-in layer so the city-wide view stays
    // readable; their live markers can be enabled independently.
    tramLines: false,
    tramTrains: false,
    liveTrains: true,
    scheduledTrains: true,
    confidenceRanges: true,
    movementTrails: true,
    reliabilityAtlas: false,
    cellGrid: false,
  });
  const [cellGridSnapshot, setCellGridSnapshot] = useState({ cells: [], generatedAt: 0 });
  const [disruptionSnapshot, setDisruptionSnapshot] = useState(disruptionStore.getSnapshot());
  const [installPrompt, setInstallPrompt] = useState(null);
  const [commuteOpen, setCommuteOpen] = useState(false);
  const [nearbyOpen, setNearbyOpen] = useState(true);
  const [isFollowingGPS, setIsFollowingGPS] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const followCleanupRef = useRef(null);
  const seenDisruptionIdsRef = useRef(new Set());

  useEffect(() => {
    const captureInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const installed = () => setInstallPrompt(null);
    window.addEventListener('beforeinstallprompt', captureInstallPrompt);
    window.addEventListener('appinstalled', installed);
    return () => {
      window.removeEventListener('beforeinstallprompt', captureInstallPrompt);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);

  // Refresh the spatial intelligence layer with the same live cache used by
  // the map. The expensive work is bounded to station/train cells and is
  // deliberately slower than the five-second marker animation.
  useEffect(() => {
    const refresh = () => {
      const now = Date.now();
      const intelligence = networkIntelligenceStore.getSnapshot();
      setCellGridSnapshot(buildCellIntelligence({
        vehicles: trainPositionEngine.getAllVehicles(now),
        entries: [...arrivalStore.memory.values()],
        issues: intelligence.issues,
        disruptions: disruptionStore.getSnapshot().alerts,
        context: mobilityContextStore.getSnapshot().context,
        userLocation,
        now,
      }));
    };
    const unsubscribe = arrivalStore.subscribe(refresh);
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, [userLocation]);

  // Save compact official delay observations once per minute. The report store
  // keeps bounded period aggregates in IndexedDB; it does not write every
  // five-second map refresh as a separate raw record.
  useEffect(() => {
    const record = () => delayReportStore.record([...arrivalStore.memory.values()], Date.now());
    const unsubscribe = arrivalStore.subscribe(record);
    record();
    const timer = setInterval(record, 30000);
    document.addEventListener('visibilitychange', record);
    return () => {
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', record);
    };
  }, []);

  // One shared network poll feeds the map, station panels and intelligence
  // views. A clicked train still performs its direct 2.5-second refresh.
  useEffect(() => {
    if (!networkSnapshotStore.isConfigured()) return undefined;
    const apply = (state) => {
      if (state.status === 'ready' && state.data) arrivalStore.hydrateSharedSnapshot(state.data);
    };
    const unsubscribe = networkSnapshotStore.subscribe(apply);
    networkSnapshotStore.refresh().then(apply);
    const timer = setInterval(() => networkSnapshotStore.refresh(), NETWORK_SNAPSHOT_INTERVAL_MS);
    return () => { unsubscribe(); clearInterval(timer); };
  }, []);

  useEffect(() => {
    const onUpdate = () => setUpdateAvailable(true);
    window.addEventListener('vienna-pwa-update', onUpdate);
    return () => window.removeEventListener('vienna-pwa-update', onUpdate);
  }, []);

  useEffect(() => () => {
    followCleanupRef.current?.();
    followCleanupRef.current = null;
  }, []);

  const installApp = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

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
    const alerts = disruptionSnapshot.alerts || [];
    const ids = new Set(alerts.map((alert) => alert.id || alert.title));
    // Establish the initial baseline silently; only later arrivals are new to
    // this open session and worth notifying about.
    if (seenDisruptionIdsRef.current.size === 0) {
      seenDisruptionIdsRef.current = ids;
      return;
    }
    if (notificationState().enabled) {
      alerts.filter((alert) => !seenDisruptionIdsRef.current.has(alert.id || alert.title))
        .forEach((alert) => notifyDisruption(alert));
    }
    seenDisruptionIdsRef.current = ids;
  }, [disruptionSnapshot.alerts]);

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
    setSelectedCell(null);
    setSelectedVehicle(null);
    setSelectedAlert(null);
    setAlertsOpen(false);
    setIntelligenceOpen(false);
    setFleetTrackerOpen(false);
    setAlertCenterOpen(false);
    setStationHubOpen(false);
    setScenarioSimulatorOpen(false);
    setSelectedStation(station);
  };

  const handleSelectVehicle = (vehicle) => {
    setSelectedCell(null);
    setSelectedStation(null);
    setSelectedAlert(null);
    setAlertsOpen(false);
    setIntelligenceOpen(false);
    setFleetTrackerOpen(false);
    setAlertCenterOpen(false);
    setStationHubOpen(false);
    setScenarioSimulatorOpen(false);
    setSelectedVehicle(vehicle);
  };

  const handleSelectCell = (cellId) => {
    const cell = cellGridSnapshot.cells.find((candidate) => candidate.id === cellId);
    if (cell) setSelectedCell(cell);
  };

  // A Station panel departure is a timetable object, while the map owns the
  // live/scheduled vehicle objects. Resolve the tap against the current map
  // snapshot before opening the vehicle card so the selected marker and its
  // details always refer to the same train.
  const handleSelectArrival = (arrival) => {
    const vehicle = findVehicleForArrival(
      trainPositionEngine.getAllVehicles(Date.now()),
      arrival,
      selectedStation?.properties?.name,
    );
    if (vehicle) {
      handleSelectVehicle(vehicle);
      return;
    }

    setLocateNotice({
      text: 'This departure is not currently visible on the map. Try again after the next live refresh.',
      _ts: Date.now(),
    });
  };

  const handleSelectAlert = (alert) => {
    if (alert) {
      setSelectedStation(null);
      setSelectedVehicle(null);
      setIsSidebarOpen(true);
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

  const stopFollowingGPS = () => {
    followCleanupRef.current?.();
    followCleanupRef.current = null;
    setIsFollowingGPS(false);
  };

  const startFollowingGPS = async () => {
    if (isFollowingGPS) return stopFollowingGPS();
    try {
      const cleanup = await watchDeviceLocation({
        onPosition: (position) => {
          const result = resultFromPosition(position);
          if (result.status === 'located') {
            setUserLocation(result);
            setNearbyOpen(true);
          }
        },
        onError: (error) => {
          stopFollowingGPS();
          setLocateNotice({ text: `Live location stopped: ${error?.message || 'GPS unavailable'}`, _ts: Date.now() });
        },
      });
      followCleanupRef.current = cleanup;
      setIsFollowingGPS(true);
      setLocateNotice({ text: 'Live location on — your position will update as you move.', _ts: Date.now() });
    } catch (error) {
      setLocateNotice({ text: `Live location unavailable: ${error?.message || 'GPS unavailable'}`, _ts: Date.now() });
    }
  };

  // Holding the locate button clears the dot. The fix is a snapshot that goes
  // stale on its own — the fade says so — and once it has served its purpose
  // there was previously no way to take it off the map short of a reload.
  const handleHideLocation = () => {
    if (!userLocation) return;
    stopFollowingGPS();
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
    setFleetTrackerOpen(false);
    setAlertCenterOpen(false);
    setStationHubOpen(false);
    setScenarioSimulatorOpen(false);
    setIntelligenceInitialTab('forecast');
    setIntelligenceOpen((open) => !open);
  };

  const openDelayPanel = () => {
    setSelectedStation(null);
    setSelectedVehicle(null);
    setSelectedAlert(null);
    setAlertsOpen(false);
    setFleetTrackerOpen(false);
    setAlertCenterOpen(false);
    setStationHubOpen(false);
    setScenarioSimulatorOpen(false);
    setCommuteOpen(false);
    setReplayOffset(0);
    setIntelligenceInitialTab('delays');
    setIntelligenceOpen(true);
  };

  const openFleetTracker = () => {
    setSelectedStation(null);
    setSelectedVehicle(null);
    setSelectedAlert(null);
    setAlertsOpen(false);
    setCommuteOpen(false);
    setReplayOffset(0);
    setAlertCenterOpen(false);
    setStationHubOpen(false);
    setScenarioSimulatorOpen(false);
    setFleetTrackerOpen(true);
  };

  const openAlertCenter = () => {
    setSelectedStation(null);
    setSelectedVehicle(null);
    setSelectedAlert(null);
    setAlertsOpen(false);
    setCommuteOpen(false);
    setIntelligenceOpen(false);
    setFleetTrackerOpen(false);
    setStationHubOpen(false);
    setScenarioSimulatorOpen(false);
    setAlertCenterOpen(true);
  };

  const openStationHub = () => {
    setSelectedStation(null);
    setSelectedVehicle(null);
    setSelectedAlert(null);
    setAlertsOpen(false);
    setCommuteOpen(false);
    setIntelligenceOpen(false);
    setFleetTrackerOpen(false);
    setAlertCenterOpen(false);
    setScenarioSimulatorOpen(false);
    setStationHubOpen(true);
  };

  const openScenarioSimulator = () => {
    setSelectedStation(null);
    setSelectedVehicle(null);
    setSelectedAlert(null);
    setAlertsOpen(false);
    setCommuteOpen(false);
    setIntelligenceOpen(false);
    setFleetTrackerOpen(false);
    setAlertCenterOpen(false);
    setStationHubOpen(false);
    setScenarioSimulatorOpen(true);
  };

  const openCommute = () => {
    setSelectedStation(null);
    setSelectedVehicle(null);
    setSelectedAlert(null);
    setAlertsOpen(false);
    setFleetTrackerOpen(false);
    setIntelligenceOpen(false);
    setAlertCenterOpen(false);
    setStationHubOpen(false);
    setScenarioSimulatorOpen(false);
    setCommuteOpen((open) => !open);
  };

  const closeIntelligence = () => {
    setIntelligenceOpen(false);
    setFleetTrackerOpen(false);
    setAlertCenterOpen(false);
    setStationHubOpen(false);
    setScenarioSimulatorOpen(false);
    setReplayOffset(0);
  };

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
        selectedVehicleId={selectedVehicle?.id || null}
        replaySnapshot={replaySnapshot}
        reliabilityScores={intelligenceSnapshot.reliability}
        gridCells={cellGridSnapshot.cells}
        cellGridVisible={mapVisibility.cellGrid}
        onSelectCell={handleSelectCell}
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
        disruptionSnapshot={disruptionSnapshot}
        selectedAlert={selectedAlert}
        onSelectAlert={handleSelectAlert}
        onRefreshAlerts={() => disruptionStore.refresh()}
        alertsOpen={alertsOpen}
        onAlertsOpenChange={setAlertsOpen}
        onOpenAlerts={() => {
          setSelectedStation(null);
          setSelectedVehicle(null);
          setIntelligenceOpen(false);
          setReplayOffset(0);
        }}
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
            onClick={openFleetTracker}
            className="top-action-button fleet-action"
            data-label="Trains"
            title="Open all-trains live tracker"
            aria-label="Open all-trains live tracker"
          >
            <TrainFront size={18} />
          </button>
          <button
            onClick={openDelayPanel}
            className={`top-action-button delay-action ${intelligenceOpen && intelligenceInitialTab === 'delays' ? 'top-action-active' : ''}`}
            data-label="Delays"
            title="Open ranked delay reports"
            aria-label="Open ranked delay reports"
            aria-pressed={intelligenceOpen && intelligenceInitialTab === 'delays'}
          >
            <Clock3 size={18} />
          </button>
          <button
            onClick={openAlertCenter}
            className={`top-action-button alert-action ${alertCenterOpen ? 'top-action-active' : ''}`}
            data-label="Alerts"
            title="Open service-alert center"
            aria-label="Open service-alert center"
            aria-pressed={alertCenterOpen}
          >
            <BellRing size={18} color={alertCenterOpen ? '#ffb74d' : undefined} />
          </button>
          <button
            onClick={openStationHub}
            className={`top-action-button station-action ${stationHubOpen ? 'top-action-active' : ''}`}
            data-label="Stations"
            title="Open station departures hub"
            aria-label="Open station departures hub"
            aria-pressed={stationHubOpen}
          >
            <MapPinned size={18} color={stationHubOpen ? '#00b4d8' : undefined} />
          </button>
          <button
            onClick={openScenarioSimulator}
            className={`top-action-button scenario-action ${scenarioSimulatorOpen ? 'top-action-active' : ''}`}
            data-label="Scenarios"
            title="Open scenario simulator"
            aria-label="Open scenario simulator"
            aria-pressed={scenarioSimulatorOpen}
          >
            <Route size={18} color={scenarioSimulatorOpen ? '#b388ff' : undefined} />
          </button>
          <button
            onClick={openIntelligence}
            className={`top-action-button intelligence-action ${intelligenceOpen ? 'top-action-active' : ''}`}
            data-label="Intelligence"
            title="Rail intelligence, replay and reliability"
            aria-label="Open rail intelligence"
            aria-pressed={intelligenceOpen}
          >
            <Activity size={18} color={intelligenceOpen ? '#4CAF50' : undefined} />
          </button>
          <button
            onClick={openCommute}
            className={`top-action-button commute-action ${commuteOpen ? 'top-action-active' : ''}`}
            data-label="Saved"
            title="My saved commute stations"
            aria-label="Open my commute"
            aria-pressed={commuteOpen}
          >
            <Star size={18} color={commuteOpen ? '#FFD166' : undefined} />
          </button>
          {installPrompt && <button
            onClick={installApp}
            className="top-action-button"
            data-label="Install"
            title="Install Vienna Rail as an app"
            aria-label="Install Vienna Rail as an app"
          >
            <Download size={18} />
          </button>}
          <button
            onClick={toggleTheme}
            className="top-action-button theme-action"
            data-label="Theme"
            title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
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

      {updateAvailable && <button className="pwa-update-banner glass-panel" onClick={() => window.location.reload()}>
        <RefreshCw size={13} /> Update available · reload Vienna Rail
      </button>}

      <LocateButton
        state={locateState}
        lifted={Boolean(selectedStation || selectedVehicle)}
        showingLocation={Boolean(userLocation)}
        onLocate={handleLocate}
        onHide={handleHideLocation}
      />

      <CellDetailPanel cell={selectedCell} onClose={() => setSelectedCell(null)} />

      {userLocation && <button
        className={`follow-gps-button glass-panel ${isFollowingGPS ? 'active' : ''}`}
        data-lifted={Boolean(selectedStation || selectedVehicle)}
        onClick={startFollowingGPS}
        title={isFollowingGPS ? 'Stop following my live location' : 'Follow my live location'}
        aria-pressed={isFollowingGPS}
      >
        <Navigation2 size={16} /> {isFollowingGPS ? 'Following' : 'Follow me'}
      </button>}

      {userLocation && nearbyOpen && !commuteOpen && !intelligenceOpen && <NearbyStations
        userLocation={userLocation}
        onSelectStation={handleSelectStation}
        onClose={() => setNearbyOpen(false)}
      />}

      {commuteOpen && <CommuteDashboard
        now={intelligenceSnapshot.generatedAt}
        onClose={() => setCommuteOpen(false)}
        onSelectStation={handleSelectStation}
      />}

      {/* Station Focus panel — right in landscape, bottom in portrait */}
      {selectedStation && (
        <StationPanel
          station={selectedStation}
          theme={theme}
          userLocation={userLocation}
          onClose={() => setSelectedStation(null)}
          onCenter={() => handleCenterStation(selectedStation)}
          onSelectArrival={handleSelectArrival}
        />
      )}

      {selectedVehicle && (
        <VehiclePanel key={selectedVehicle.id} vehicle={selectedVehicle} onClose={() => setSelectedVehicle(null)} />
      )}

      {fleetTrackerOpen && (
        <FleetTracker
          theme={theme}
          onClose={() => setFleetTrackerOpen(false)}
          onSelectVehicle={handleSelectVehicle}
        />
      )}

      {alertCenterOpen && (
        <AlertCenter
          snapshot={disruptionSnapshot}
          selectedAlert={selectedAlert}
          onSelectAlert={setSelectedAlert}
          onRefresh={() => disruptionStore.refresh()}
          onClose={() => { setAlertCenterOpen(false); setSelectedAlert(null); }}
        />
      )}

      {stationHubOpen && (
        <StationDeparturesHub
          theme={theme}
          onClose={() => setStationHubOpen(false)}
          onSelectStation={(station) => { setStationHubOpen(false); handleSelectStation(station); }}
        />
      )}

      {scenarioSimulatorOpen && (
        <ScenarioSimulator
          issues={intelligenceSnapshot.issues}
          disruptions={disruptionSnapshot.alerts}
          onClose={() => setScenarioSimulatorOpen(false)}
        />
      )}

      {intelligenceOpen && (
        <RailIntelligence
          snapshot={intelligenceSnapshot}
          disruptions={disruptionSnapshot.alerts}
          replayOffset={replayOffset}
          replaySnapshot={replaySnapshot}
          officialSnapshotState={officialSnapshotState}
          officialReplaySnapshot={officialReplaySnapshot}
          initialTab={intelligenceInitialTab}
          userLocation={userLocation}
          cellGridVisible={mapVisibility.cellGrid}
          onToggleCellGrid={() => setMapVisibility((previous) => ({ ...previous, cellGrid: !previous.cellGrid }))}
          onReplayChange={setReplayOffset}
          atlasVisible={mapVisibility.reliabilityAtlas}
          onToggleAtlas={() => setMapVisibility((previous) => ({
            ...previous,
            reliabilityAtlas: !previous.reliabilityAtlas,
          }))}
          onClose={closeIntelligence}
        />
      )}

    </div>
  );
}

export default App;

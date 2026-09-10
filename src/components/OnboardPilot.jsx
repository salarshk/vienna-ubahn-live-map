import React, { useEffect, useRef, useState } from 'react';
import { LocateFixed, ShieldCheck, Square } from 'lucide-react';
import trainPositionEngine, { projectPointOntoPolyline } from '../services/trainPositionEngine';

const STORAGE_KEY = 'vienna_onboard_pilot_v1';
const U_LINES = ['U1', 'U2', 'U3', 'U4', 'U6'];

const OnboardPilot = () => {
  const watchRef = useRef(null);
  const [state, setState] = useState({ status: 'idle', samples: 0, match: null, message: '' });

  const stop = () => {
    if (watchRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    watchRef.current = null;
    setState((previous) => ({ ...previous, status: 'idle', message: 'Stopped. No raw GPS trail was retained.' }));
  };

  useEffect(() => () => {
    if (watchRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
  }, []);

  const accept = (position) => {
    const point = [position.coords.longitude, position.coords.latitude];
    let best = null;
    for (const line of U_LINES) {
      const track = trainPositionEngine.getLineTrack(line);
      if (!track) continue;
      const projected = projectPointOntoPolyline(point, track.coords, track.cumDists);
      if (!best || projected.perpDistance < best.perpDistance) best = { line, ...projected };
    }
    if (!best || best.perpDistance > Math.max(180, position.coords.accuracy * 2)) {
      setState((previous) => ({ ...previous, message: 'No U-Bahn track match yet. Stay onboard while the GPS settles.' }));
      return;
    }

    // Deliberately discard longitude and latitude. Only a 100 m track bin and
    // rounded accuracy survive, which is enough to test operator-independent
    // location evidence without retaining a passenger's route.
    const sample = {
      at: Date.now(),
      line: best.line,
      trackBin: Math.round(best.distAlongTrack / 100) * 100,
      accuracy: Math.ceil(position.coords.accuracy / 25) * 25,
    };
    let samples = [];
    try {
      samples = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(samples)) samples = [];
      samples.push(sample);
      samples = samples.filter((item) => Date.now() - item.at < 30 * 60 * 1000).slice(-60);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(samples));
    } catch {
      samples = [sample];
    }
    setState({
      status: 'recording',
      samples: samples.length,
      match: best.line,
      message: `${best.line} matched within ${Math.round(best.perpDistance)} m.`,
    });
  };

  const start = () => {
    if (!navigator.geolocation) {
      setState({ status: 'error', samples: 0, match: null, message: 'Location is unavailable on this device.' });
      return;
    }
    setState((previous) => ({ ...previous, status: 'requesting', message: 'Waiting for permission and a GPS fix…' }));
    watchRef.current = navigator.geolocation.watchPosition(
      accept,
      (error) => setState((previous) => ({
        ...previous,
        status: 'error',
        message: error.code === 1 ? 'Location permission was not granted.' : 'A reliable GPS fix is not available yet.',
      })),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  };

  return (
    <div className="onboard-pilot">
      <div className="onboard-pilot-heading"><ShieldCheck size={15} /><strong>Onboard GPS pilot</strong></div>
      <p>Opt in while riding. This prototype keeps only a rounded track position on this device—never your raw coordinates.</p>
      {state.status === 'recording' || state.status === 'requesting' ? (
        <button className="onboard-stop" onClick={stop}><Square size={13} />Stop contributing</button>
      ) : (
        <button className="onboard-start" onClick={start}><LocateFixed size={14} />Start onboard pilot</button>
      )}
      {state.message && <div className={`onboard-status ${state.status}`}>{state.message}{state.samples ? ` ${state.samples} private samples.` : ''}</div>}
      <small>A shared anonymous feed needs a separate privacy-reviewed server and several matching riders before any point can be published.</small>
    </div>
  );
};

export default OnboardPilot;

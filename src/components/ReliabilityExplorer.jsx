import React, { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { buildDelayOnsets, buildReliabilityRanking, fetchRailHistory, railHistoryUrl, RAIL_HISTORY_URL } from '../services/sharedRailHistory';
import { lineColor } from '../utils/lineColor';

const formatDelay = (seconds) => `${(seconds / 60).toFixed(1)} min`;

const ReliabilityExplorer = () => {
  const [line, setLine] = useState('U1');
  const [days, setDays] = useState(7);
  const [result, setResult] = useState({ key: null, data: null });
  const [error, setError] = useState('');
  const queryKey = `${line}|${days}`;
  const isSbahn = line.startsWith('S');
  const history = !isSbahn && result.key === queryKey ? result.data : null;
  const sbahnHistory = isSbahn && result.key === queryKey ? result.data : null;
  useEffect(() => {
    let active = true;
    const sbahnUrl = RAIL_HISTORY_URL?.replace(/\/rail-history(?:\?.*)?$/, '/sbahn-punctuality');
    const refresh = () => (line.startsWith('S')
      ? sbahnUrl
        ? fetch(sbahnUrl, { headers: { Accept: 'application/json' } }).then((response) => {
          if (!response.ok) throw new Error(`S-Bahn archive HTTP ${response.status}`);
          return response.json();
        })
        : Promise.resolve({ status: 'not configured', rows: [] })
      : fetchRailHistory({ line, days })).then((data) => {
      if (active) { setResult({ key: queryKey, data }); setError(''); }
    }).catch((reason) => { if (active) setError(reason.message); });
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => { active = false; clearInterval(timer); };
  }, [line, days, queryKey]);
  const ranking = useMemo(() => buildReliabilityRanking(history), [history]);
  const onsets = useMemo(() => buildDelayOnsets(history), [history]);
  const hourRows = useMemo(() => {
    const groups = new Map();
    for (const row of history?.hourly || []) {
      const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vienna', hour: '2-digit', hourCycle: 'h23' }).format(new Date(row.hour));
      const item = groups.get(hour) || { hour, labelled: 0, delay: 0 };
      item.labelled += Number(row.labelledObservations) || 0;
      item.delay += Number(row.delaySumSeconds) || 0;
      groups.set(hour, item);
    }
    return [...groups.values()].filter((row) => row.labelled).sort((a, b) => a.hour.localeCompare(b.hour));
  }, [history]);
  const csvUrl = railHistoryUrl({ line, days, format: 'csv' });
  const jsonUrl = railHistoryUrl({ line, days });
  const sbahnUrl = RAIL_HISTORY_URL?.replace(/\/rail-history(?:\?.*)?$/, '/sbahn-punctuality');
  return <section className="intelligence-section reliability-explorer">
    <div className="intelligence-section-title"><ExternalLink size={14} /><strong>Public reliability explorer</strong></div>
    <div className="explorer-controls">
      <label>Line <select value={line} onChange={(event) => setLine(event.target.value)}>{['U1', 'U2', 'U3', 'U4', 'U6', 'S1', 'S2', 'S3', 'S4', 'S7', 'S40', 'S45', 'S50', 'S60', 'S80', '1', '2', 'D', 'O'].map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>History <select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={1}>1 day</option><option value={7}>7 days</option><option value={14}>14 days</option></select></label>
    </div>
    <div className="explorer-downloads">
      {(isSbahn ? sbahnUrl && `${sbahnUrl}?format=csv` : csvUrl) && <a href={isSbahn ? `${sbahnUrl}?format=csv` : csvUrl} download={isSbahn ? 'vienna-sbahn-punctuality.csv' : 'vienna-rail-reliability.csv'}><Download size={13} /> CSV</a>}
      {(isSbahn ? sbahnUrl : jsonUrl) && <a href={isSbahn ? sbahnUrl : jsonUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> JSON</a>}
    </div>
    {error && <p className="advanced-caveat">Shared history unavailable: {error}. The live map still works.</p>}
    {(history?.status === 'not configured' || sbahnHistory?.status === 'not configured') && <p className="advanced-empty">Shared history is not configured in this preview. It appears on the published site once the Cloudflare archive is connected.</p>}
    {!history && !sbahnHistory && !error && <p className="advanced-empty">Loading Cloudflare history…</p>}
    {isSbahn && sbahnHistory && <>
      <p className="intelligence-note">ÖBB archive: {sbahnHistory.status}. {sbahnHistory.coverage || sbahnHistory.reason || 'Waiting for the weekly source join.'} This is not live S-Bahn positioning.</p>
      {sbahnHistory.status === 'ready' ? <div className="explorer-ranking">{(sbahnHistory.rows || []).filter((row) => row.line === line).sort((a, b) => b.meanDelaySeconds - a.meanDelaySeconds).slice(0, 18).map((row) => <div key={`${row.station}-${row.line}-${row.hour}-${row.kind}`}><b style={{ color: lineColor(row.line) }}>{row.line}</b><span>{row.station}<small> · {String(row.hour).padStart(2, '0')}:00 · {row.kind}</small></span><strong>{formatDelay(row.meanDelaySeconds)}</strong><small>{row.observations} runs</small></div>)}</div> : <p className="advanced-empty">The weekly ÖBB file does not yet have a validated S-line/station join. We do not substitute all-train or timetable values for S-Bahn punctuality.</p>}
    </>}
    {!isSbahn && history?.status === 'collecting' && <p className="advanced-empty">The scheduled shared archive is collecting its first samples.</p>}
    {!isSbahn && history?.status === 'stale' && <p className="advanced-caveat">Shared history is {Math.round((history.archiveAgeSeconds || 0) / 60)} minutes old. The rankings below are historical; live train positions and arrivals use a separate feed.</p>}
    {!isSbahn && ['ready', 'stale'].includes(history?.status) && <>
      <p className="intelligence-note">The collector checks each minute and stores dated observations in Cloudflare R2. Repeated departure observations are not unique trains or verified physical arrivals. Hourly reports may lag the live map.</p>
      <h4>Most delayed stations and directions</h4>
      {ranking.length ? <div className="explorer-ranking">{ranking.slice(0, 12).map((row) => <div key={`${row.stationName}-${row.line}-${row.direction}`}>
        <b style={{ color: lineColor(row.line) }}>{row.line}</b><span>{row.stationName}<small> → {row.direction || 'all directions'}</small></span><strong>{formatDelay(row.meanDelaySeconds)}</strong><small>{row.labelledObservations} samples</small>
      </div>)}</div> : <p className="advanced-empty">Waiting for at least three labelled samples per station and direction.</p>}
      <h4>ETA prediction stability by station</h4>
      {ranking.filter((row) => row.etaPairs >= 3).length ? <div className="explorer-ranking">{ranking.filter((row) => row.etaPairs >= 3).sort((a, b) => a.stableEtaPercent - b.stableEtaPercent).slice(0, 8).map((row) => <div key={`eta-${row.stationName}-${row.line}-${row.direction}`}>
        <b style={{ color: lineColor(row.line) }}>{row.line}</b><span>{row.stationName}<small> → {row.direction || 'all directions'}</small></span><strong>{row.stableEtaPercent}%</strong><small>{row.etaPairs} comparisons</small>
      </div>)}</div> : <p className="advanced-empty">ETA quality needs repeated observations of the same departure.</p>}
      <h4>Where reported delays are rising</h4>
      {onsets.length ? <div className="explorer-ranking">{onsets.map((row) => <div key={`rise-${row.stationName}-${row.line}-${row.direction}`}><b style={{ color: lineColor(row.line) }}>{row.line}</b><span>{row.stationName}<small> → {row.direction || 'all directions'}</small></span><strong>+{formatDelay(row.riseSeconds)}</strong></div>)}</div> : <p className="advanced-empty">No station and direction has a sustained 60-second rise across the last hour.</p>}
      <h4>Average reported delay by hour in Vienna</h4>
      {hourRows.length ? <div className="explorer-hours">{hourRows.map((row) => <span key={row.hour}>{row.hour}:00 <b>{formatDelay(row.delay / row.labelled)}</b></span>)}</div> : <p className="advanced-empty">Hourly history starts with the first scheduled sample.</p>}
    </>}
  </section>;
};

export default ReliabilityExplorer;

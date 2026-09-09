// Dashboard mode: a departure board for a tablet on a shelf.
//
// No map and nothing to touch. It rotates through a few Stations on its own,
// because the thing it replaces is a board on a wall, not an app.
//
// Type is sized from the research rather than by eye. DfT Inclusive Mobility
// gives character height = viewing distance / 137.5, TCRP 45 specifies 1/4°
// for wall-mounted transit information, and tvOS body is 29 pt at ~8 ft; those
// converge on roughly 42-75 CSS px at 2 m on a tablet-class display. The
// destination row targets the middle of that band at tablet width.
// See docs/research/transit-ui-best-practice.md.
import React, { useEffect, useState } from 'react';
import arrivalStore, { NETWORK_SYNC_INTERVAL_MS } from '../services/arrivalStore';
import { getStationFocus } from '../services/stationFocus';
import { countdownHeat, countdownLabel } from '../utils/countdownHeat';
import { lineColor } from '../utils/lineColor';

const ROTATE_MS = 12000;

// Three interchanges cover all five operating U-Bahn lines.
const BOARD_STATIONS = [
  { apiId: 60201320, name: 'Stephansplatz', lines: ['U1', 'U3'] },
  { apiId: 60201182, name: 'Schottenring', lines: ['U2', 'U4'] },
  { apiId: 60201468, name: 'Westbahnhof', lines: ['U3', 'U6'] },
];

const DashboardBoard = ({ theme, onExit }) => {
  const [now, setNow] = useState(Date.now());
  const [slot, setSlot] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    (async () => {
      await arrivalStore.seedStrategicHubs();
      await arrivalStore.syncNetwork();
    })();
    const sync = setInterval(() => arrivalStore.syncNetwork(), NETWORK_SYNC_INTERVAL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(sync); clearInterval(tick); };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setProgress((p) => {
        if (p + 100 / (ROTATE_MS / 100) >= 100) {
          setSlot((s) => (s + 1) % BOARD_STATIONS.length);
          return 0;
        }
        return p + 100 / (ROTATE_MS / 100);
      });
    }, 100);
    return () => clearInterval(id);
  }, []);

  const station = BOARD_STATIONS[slot];
  const focus = getStationFocus(station, now);
  const rows = focus.arrivals.slice(0, 6);

  const isLight = theme === 'light';
  const bg = isLight ? '#ffffff' : '#05060a';
  const fg = isLight ? '#121212' : '#ffffff';
  const dim = isLight ? '#5f6368' : '#6b7280';
  const rule = isLight ? 'rgba(0,0,0,.10)' : '#14161c';

  return (
    <div style={{
      position: 'absolute', inset: 0, background: bg, color: fg,
      display: 'flex', flexDirection: 'column',
      padding: 'clamp(16px, 3vw, 48px)',
      paddingTop: 'calc(clamp(16px, 3vw, 48px) + env(safe-area-inset-top, 0px))',
      fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      <header style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 24,
        // Bold display type at this size needs the extra room below: at 1.02
        // line-height a descender (the "g" in "Guimerà") visually bled into
        // the first departure row, which centres in the space below and so
        // sits closer to the header the fewer rows there are.
        paddingBottom: 'clamp(8px, 1.4vh, 20px)',
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 'clamp(11px, 1.4vw, 20px)', letterSpacing: '.28em',
            textTransform: 'uppercase', color: dim, fontWeight: 700,
          }}>
            Departures
          </div>
          <h1 style={{
            fontSize: 'clamp(32px, 7vw, 104px)', fontWeight: 800, lineHeight: 1.2,
            letterSpacing: '-.02em', margin: '.06em 0 0',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {station.name}
          </h1>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
          <div style={{
            fontSize: 'clamp(28px, 5.4vw, 82px)', fontWeight: 300, lineHeight: 1,
            fontVariantNumeric: 'tabular-nums', color: dim,
          }}>
            {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
          {/* The only control on the board, and deliberately quiet: an
              unattended display should be hard to tap out of by accident. */}
          <button
            onClick={onExit}
            title="Back to the map"
            style={{
              minWidth: 44, minHeight: 44, borderRadius: 12, cursor: 'pointer',
              background: 'transparent', border: `1px solid ${rule}`, color: dim,
              fontSize: 18, lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      </header>

      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
        gap: 'clamp(6px, 1.2vh, 18px)', minHeight: 0,
        // Row type is sized by vw, so it stays glanceable regardless of
        // height, but does not shrink to fit a short, wide window on its own
        // — found by testing at 1512x809, where six rows ran past the
        // footer. Top-aligned with a hard clip: a partial last row reads as
        // "more below", the ordinary way a departure board runs out of room.
        // Centering (the alternative) clipped the FIRST row instead, which
        // reads as broken rather than as a board that goes on further.
        overflow: 'hidden',
      }}>
        {rows.length === 0 && (
          <p style={{ fontSize: 'clamp(18px, 2.6vw, 38px)', color: dim, textAlign: 'center' }}>
            No live predictions for {station.name}
          </p>
        )}
        {rows.map((a, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: 'auto 1fr auto auto',
            alignItems: 'center', gap: 'clamp(10px, 2vw, 30px)',
            padding: 'clamp(6px, 1.2vh, 16px) 0',
            borderBottom: i === rows.length - 1 ? 'none' : `1px solid ${rule}`,
          }}>
            <span style={{
              width: 'clamp(40px, 5.4vw, 80px)', height: 'clamp(40px, 5.4vw, 80px)',
              borderRadius: 'clamp(9px, 1.3vw, 18px)',
              background: lineColor(a.line), color: '#000',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 'clamp(18px, 2.8vw, 42px)', fontWeight: 900,
            }}>
              {a.line}
            </span>

            <span style={{
              // 42-75px is the band the research converges on for 2m viewing
              // distance; 3.6vw only reached the middle of it (~58px) above
              // ~1600px wide, undershooting the floor on real tablet-class
              // widths (1024-1366px landscape). 5.71vw puts 1024px exactly at
              // the band's middle and saturates at the 75px cap by ~1366px,
              // rather than missing the band on the devices it's meant for.
              fontSize: 'clamp(42px, 5.71vw, 75px)', fontWeight: 700, lineHeight: 1.1,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
            }}>
              {a.destination}
            </span>

            {/* Clock time beside the countdown: the board convention, and what
                you plan around when you are not leaving this minute. */}
            <span style={{
              fontSize: 'clamp(15px, 2.2vw, 34px)', color: dim,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {new Date(a.targetTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>

            <span style={{
              fontSize: 'clamp(24px, 4vw, 64px)', fontWeight: 800,
              fontVariantNumeric: 'tabular-nums', textAlign: 'right',
              minWidth: 'clamp(96px, 13vw, 210px)',
              color: countdownHeat(a.seconds, theme),
            }}>
              {countdownLabel(a.seconds)}
              {a.seconds > 0 && <span style={{ fontSize: '.42em', fontWeight: 600, marginLeft: 4 }}>min</span>}
            </span>
          </div>
        ))}
      </div>

      <footer>
        <div style={{ height: 3, background: rule, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${progress}%`, background: dim, opacity: .7 }} />
        </div>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginTop: 10, fontSize: 'clamp(10px, 1.3vw, 17px)', color: dim,
        }}>
          <span>{BOARD_STATIONS.map((s, i) => (i === slot ? '●' : '○')).join(' ')} next: {BOARD_STATIONS[(slot + 1) % BOARD_STATIONS.length].name}</span>
          <span>
            {focus.secondsUnheard === null ? 'never fetched'
              : focus.isFresh ? 'live'
                : `confirmed ${Math.max(1, Math.round(focus.secondsUnheard / 60))} min ago`}
          </span>
        </div>
      </footer>
    </div>
  );
};

export default DashboardBoard;

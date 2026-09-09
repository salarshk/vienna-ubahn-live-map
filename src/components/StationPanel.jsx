// The panel for the Station in focus: its name, whether what we are showing
// came from the API just now or is a countdown running on from memory, and the
// arrivals table.
//
// Docked right in landscape and bottom in portrait. Right, because on a held
// tablet that is where a thumb rests; bottom in portrait, because on a phone it
// is the only place a thumb reaches at all.
import React, { useEffect, useState } from 'react';
import { X, Radio, Database, Navigation } from 'lucide-react';
import arrivalStore from '../services/arrivalStore';
import { getStationFocus } from '../services/stationFocus';
import { countdownHeat, countdownLabel } from '../utils/countdownHeat';
import { lineColor } from '../utils/lineColor';
import { LANDSCAPE_BREAKPOINT_PX } from '../utils/layout';

// Landscape docks the panel right, portrait docks it bottom. Measured rather
// than read from an orientation media query, because a narrow landscape window
// on a desktop should get the portrait treatment too.
const useIsLandscape = () => {
  const [landscape, setLandscape] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= LANDSCAPE_BREAKPOINT_PX
  );
  useEffect(() => {
    const onResize = () => setLandscape(window.innerWidth >= LANDSCAPE_BREAKPOINT_PX);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return landscape;
};

const StationPanel = ({ station, theme, onClose, onCenter }) => {
  const [now, setNow] = useState(Date.now());
  const landscape = useIsLandscape();

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // getStationFocus only ever reads arrivalStore's cache — it has to, since it
  // also runs inside MapView's floating node every second and must not fire a
  // network request from there. Something has to be the one place that
  // actually asks the API for the Station just clicked, or any Station
  // outside the Strategic Hubs and Major Stations stays "confirmed never
  // fetched" forever, however live its real trains are. That's this effect.
  useEffect(() => {
    if (!station) return undefined;
    arrivalStore.getStationArrivals(station.properties);
    const id = setInterval(
      () => arrivalStore.getStationArrivals(station.properties),
      60000
    );
    return () => clearInterval(id);
  }, [station]);

  if (!station) return null;

  const focus = getStationFocus(station.properties, now);
  const unheardLabel = focus.secondsUnheard === null
    ? 'never fetched'
    : focus.secondsUnheard < 60
      ? 'just now'
      : `${Math.round(focus.secondsUnheard / 60)} min ago`;

  return (
    <aside
      className="glass-panel station-panel"
      data-landscape={landscape ? 'true' : 'false'}
      style={{
        position: 'absolute',
        zIndex: 30,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        ...(landscape
          // top clears the search bar's own row (its container sits at
          // top:20, height ~52px) — starting level with it let the panel's
          // z-index paint over the theme and dashboard-mode buttons, making
          // them unclickable while a station was focused.
          ? { top: 84, right: 16, maxHeight: 'calc(100vh - 100px)', width: 'min(380px, 34vw)' }
          : { left: 0, right: 0, bottom: 0, paddingBottom: 'env(safe-area-inset-bottom, 0px)', maxHeight: '58vh', borderRadius: '18px 18px 0 0' }),
      }}
    >
      {/* Header: which station, and how trustworthy this is */}
      <header style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 12, padding: '16px 16px 12px', borderBottom: '1px solid var(--border-color)',
      }}>
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8, overflow: 'hidden' }}>
          <h2 style={{
            fontSize: '1.05rem', fontWeight: 800, lineHeight: 1.15,
            letterSpacing: '-.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            minWidth: 0, flexShrink: 1,
          }}>
            {focus.name}
          </h2>

          {/* Live API vs memory. Two different claims, so they never share a
              treatment: one was fetched now, the other is a countdown running
              on from an older fetch. Sharing the name's line rather than a row
              of its own is what makes the compacted header fit in one line. */}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
            padding: '2px 7px', borderRadius: 999, fontSize: '.62rem', fontWeight: 700,
            letterSpacing: '.03em', whiteSpace: 'nowrap',
            color: focus.isFresh ? '#4CAF50' : '#00B4D8',
            background: focus.isFresh ? 'rgba(76,175,80,.15)' : 'rgba(0,180,216,.15)',
          }}>
            {focus.isFresh
              ? <><Radio size={9} className="pulse" /> LIVE</>
              : <><Database size={9} /> MEMORY</>}
          </span>
          <span style={{ fontSize: '.64rem', color: 'var(--text-secondary)', flexShrink: 0, whiteSpace: 'nowrap' }}>
            confirmed {unheardLabel}
          </span>
        </div>

        <button
          onClick={onClose}
          aria-label="Close station panel"
          style={{
            width: 32, height: 32, minWidth: 32, borderRadius: '50%', border: 'none',
            background: 'var(--bg-hover)', color: 'var(--text-primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}
        >
          <X size={16} />
        </button>
      </header>

      {/* Directions summary — the same split the expanded marker draws. One
          row per direction rather than side-by-side cards: a two-column grid
          halved the width available to the destination text, and real names
          (several termini joined by middle dots) wrapped and got cut
          in that half-width even at two lines. Full width, single line,
          ellipsis beyond it — still the full name on hover/long-press via
          title, but the common case reads at a glance instead of wrapping. */}
      {focus.directions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--border-color)', flexShrink: 0 }}>
          {focus.directions.map((d) => {
            const next = d.arrivals[0];
            return (
              <div
                key={d.key}
                title={d.label}
                style={{
                  background: 'var(--bg-panel-solid)', padding: '9px 10px',
                  display: 'flex', alignItems: 'center', gap: 7,
                }}
              >
                {/* The line badge names which train the countdown belongs to
                    — a direction can merge more than one Line (two Lines
                    leaving an interchange the same way), so "next" is only
                    ever one specific train, not the direction as a whole. */}
                {next && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    minWidth: 17, height: 17, padding: '0 4px', borderRadius: 5,
                    background: lineColor(next.line), color: '#000',
                    fontSize: '.6rem', fontWeight: 900, flexShrink: 0,
                  }}>
                    {next.line}
                  </span>
                )}
                <span style={{ fontSize: '.7rem', color: 'var(--text-secondary)', flexShrink: 0 }}>→</span>
                <div style={{
                  flex: 1, minWidth: 0, fontSize: '.76rem', fontWeight: 600,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {d.label}
                </div>
                {next && (
                  /* Deliberately larger than the table below: the soonest train
                     each way is the answer to the question the panel was opened
                     to ask, and everything under it is context. */
                  <div style={{
                    fontSize: '1.2rem', fontWeight: 800, flexShrink: 0, lineHeight: 1,
                    fontVariantNumeric: 'tabular-nums',
                    color: countdownHeat(next.seconds, theme),
                  }}>
                    {countdownLabel(next.seconds)}
                    {next.seconds > 0 && <span style={{ fontSize: '.6rem', fontWeight: 600, marginLeft: 2 }}>min</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* The table. Capped to roughly three rows so the panel stays compact —
          scrolling this area (not the whole panel) reveals the rest.

          It lists `laterArrivals`, not every arrival: the soonest train each way
          is already the headline above, and repeating it here made a Station
          with two trains due render the same two trains twice, once as rows and
          once as a table. What is left is what the headlines have not said. */}
      <div style={{ maxHeight: 176, overflowY: 'auto', padding: '4px 8px 8px' }}>
        {focus.fetchError && (
          <div role="status" style={{
            margin: '8px', padding: '8px 10px', borderRadius: 8,
            background: 'rgba(255,152,0,.14)', color: '#ffb74d', fontSize: '.72rem', lineHeight: 1.35,
          }}>
            {focus.fetchError}
          </div>
        )}

        {focus.arrivals.length === 0 ? (
          <p style={{ padding: 20, textAlign: 'center', fontSize: '.8rem', color: 'var(--text-secondary)' }}>
            No live trains arriving soon.
          </p>
        ) : focus.laterArrivals.length === 0 ? (
          /* Everything due is already in the headlines. Saying so beats an
             empty table with a header row over nothing. */
          <p style={{ padding: '12px 20px', textAlign: 'center', fontSize: '.74rem', color: 'var(--text-secondary)' }}>
            Nothing further due yet.
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
            <caption className="visually-hidden">Later arrivals at {focus.name}</caption>
            <thead>
              <tr style={{
                fontSize: '.62rem', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text-secondary)',
                // Stays visible while scrolling past the third row, so the
                // columns are never unlabelled once there's more to scroll to.
                position: 'sticky', top: 0, background: 'var(--bg-panel-solid)',
              }}>
                <th scope="col" style={{ textAlign: 'left', padding: '6px 8px 5px', fontWeight: 700 }}>Line</th>
                <th scope="col" style={{ textAlign: 'left', padding: '6px 8px 5px', fontWeight: 700 }}>Towards</th>
                <th scope="col" style={{ textAlign: 'right', padding: '6px 8px 5px', fontWeight: 700 }}>Due</th>
              </tr>
            </thead>
            <tbody>
              {focus.laterArrivals.map((a, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border-color)' }}>
                  {/* Line identity is a labelled badge, never colour alone */}
                  <td style={{ padding: '7px 8px', width: 1 }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      minWidth: 24, height: 24, padding: '0 6px', borderRadius: 7,
                      background: lineColor(a.line), color: '#000',
                      fontSize: '.72rem', fontWeight: 900,
                    }}>
                      {a.line}
                    </span>
                  </td>
                  <td style={{ padding: '7px 8px', maxWidth: 0 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                      {a.destination}
                    </div>
                    {a.vehicleId && (
                      <div style={{ fontSize: '.62rem', color: 'var(--text-secondary)' }}>
                        Train #{a.vehicleId}
                      </div>
                    )}
                  </td>
                  <td style={{
                    padding: '7px 8px', textAlign: 'right', whiteSpace: 'nowrap',
                    fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                    color: countdownHeat(a.seconds, theme),
                  }}>
                    {countdownLabel(a.seconds)}
                    {a.seconds > 0 && <span style={{ fontSize: '.62rem', fontWeight: 600, marginLeft: 3 }}>min</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer style={{ padding: 10, borderTop: '1px solid var(--border-color)' }}>
        <button
          onClick={onCenter}
          style={{
            width: '100%', minHeight: 44, borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'var(--bg-hover)', color: 'var(--text-primary)',
            fontWeight: 700, fontSize: '.82rem',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}
        >
          <Navigation size={15} />
          Recentre on map
        </button>
      </footer>
    </aside>
  );
};

export default StationPanel;

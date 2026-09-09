// Station Focus
//
// Everything the UI needs about one Station at one instant: the flat arrivals
// table the panel draws, the at-most-two Direction Groups the expanded Station
// marker draws, and the arrivals those Groups have not already headlined.
//
// Direction is the engine's answer, not a string match on the headsign.
// `resolveDirection` says whether a train is travelling towards increasing
// track distance, and that is the same axis for every Line through a Station,
// so trains on different Lines heading the same way land in the same group. A
// terminus yields one group rather than two — the "if applicable" in "both
// directions if applicable".
import arrivalStore from './arrivalStore';
import trainPositionEngine from './trainPositionEngine';

// How many termini a Direction Group names before it gives up and counts.
const MAX_LABELLED_DESTINATIONS = 3;

// Averaged as unit vectors, because bearings wrap: the mean of 350° and 10° is
// 0°, not 180°.
const meanBearing = (bearings) => {
  if (bearings.length === 0) return null;
  const toRad = Math.PI / 180;
  const x = bearings.reduce((sum, b) => sum + Math.cos(b * toRad), 0);
  const y = bearings.reduce((sum, b) => sum + Math.sin(b * toRad), 0);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
};

const label = (destinations) => {
  if (destinations.length === 0) return 'Onwards';
  if (destinations.length <= MAX_LABELLED_DESTINATIONS) return destinations.join(' · ');
  const shown = destinations.slice(0, MAX_LABELLED_DESTINATIONS);
  return `${shown.join(' · ')} +${destinations.length - shown.length}`;
};

/**
 * @param {{name: string, apiId?: number, lines?: string[]}} stationProps
 * @param {number} now
 */
export const getStationFocus = (stationProps, now = Date.now()) => {
  const cached = stationProps ? arrivalStore.getCachedArrivals(stationProps, now) : null;
  const arrivals = cached ? cached.arrivals : [];

  // Keyed by direction so several Lines heading the same way merge, which is
  // the whole point: one group per service would become a table, not a glance.
  const groups = new Map();

  for (const arrival of arrivals) {
    const lineId = String(arrival.line);
    const onLine = trainPositionEngine.findStation(lineId, stationProps.name);
    // A Station its Line's geometry cannot reach has no direction we can trust
    // — see Off-Track Station. It still belongs in the table below; it just
    // cannot be drawn on a side of the marker.
    if (!onLine) continue;

    const isForward = trainPositionEngine.resolveDirection(lineId, arrival.destination, onLine);
    const key = isForward ? 'forward' : 'backward';
    if (!groups.has(key)) groups.set(key, { key, destinations: [], arrivals: [], bearings: [] });

    const group = groups.get(key);
    group.arrivals.push(arrival);
    // Which way the track actually points as it leaves this Station. On one
    // Line the two groups are opposite headings; across Lines at an
    // interchange they are not, because "forward" is per-Line. The marker
    // orients its arms from this rather than assuming up and down.
    const { bearing } = trainPositionEngine
      .getCoordsAndBearingAtDistance(lineId, onLine.trackDist, isForward);
    group.bearings.push(bearing);
    if (arrival.destination && !group.destinations.includes(arrival.destination)) {
      group.destinations.push(arrival.destination);
    }
  }

  // 'forward' before 'backward' always, so a display left running does not
  // swap its two halves every time a train arrives.
  const directions = ['forward', 'backward']
    .filter((key) => groups.has(key))
    .map((key) => {
      const group = groups.get(key);
      return {
        key,
        destinations: group.destinations,
        label: label(group.destinations),
        bearing: meanBearing(group.bearings),
        arrivals: group.arrivals.slice().sort((a, b) => a.seconds - b.seconds),
      };
    });

  // Each Direction Group's soonest train is the headline the panel and the
  // marker both lead with, so listing it again in the table below says the same
  // thing twice — and at a Station with two trains due, the table becomes a
  // verbatim repeat of the two rows above it. These are the ones left to say.
  const headlined = new Set(directions.map((d) => d.arrivals[0]));

  return {
    name: stationProps ? stationProps.name : '',
    lines: (stationProps && stationProps.lines) || [],
    arrivals: arrivals.slice().sort((a, b) => a.seconds - b.seconds),
    laterArrivals: arrivals
      .filter((arrival) => !headlined.has(arrival))
      .sort((a, b) => a.seconds - b.seconds),
    directions,
    isFresh: Boolean(cached && cached.isFresh),
    fetchedAt: cached ? cached.fetchedAt : null,
    secondsUnheard: cached && cached.fetchedAt ? Math.round((now - cached.fetchedAt) / 1000) : null,
    fetchError: cached ? cached.fetchError : null,
  };
};

export default getStationFocus;

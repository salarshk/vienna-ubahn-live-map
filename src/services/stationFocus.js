// Station Focus
//
// Everything the UI needs about one Station at one instant: the flat arrivals
// table the panel draws, the per-line Direction Groups the expanded Station
// marker draws, and the arrivals those Groups have not already headlined.
//
// Direction is the engine's answer, using Wiener Linien's H/R value whenever
// available. Groups are line-relative: two lines crossing at an interchange
// must never be merged just because both imported geometries call one side
// "forward"; their real compass bearings can differ by more than 100°.
import arrivalStore from './arrivalStore';
import trainPositionEngine from './trainPositionEngine';
import { getScheduledSbahnArrivals } from './sbahnSchedule';

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
  const realtimeArrivals = cached ? cached.arrivals : [];
  const scheduledArrivals = getScheduledSbahnArrivals(stationProps, now);
  const arrivals = [...realtimeArrivals, ...scheduledArrivals];

  // Keyed by line and direction. Several destinations on the same side of one
  // line (for example a short-turn service) still share a concise group.
  const groups = new Map();

  for (const arrival of arrivals) {
    const lineId = String(arrival.line);
    const onLine = trainPositionEngine.findStation(lineId, stationProps.name);
    // A Station its Line's geometry cannot reach has no direction we can trust
    // — see Off-Track Station. It still belongs in the table below; it just
    // cannot be drawn on a side of the marker.
    if (!onLine) continue;

    const isForward = trainPositionEngine.resolveDirection(
      lineId, arrival.destination, onLine, arrival.directionCode
    );
    const direction = isForward ? 'forward' : 'backward';
    const key = `${lineId}:${direction}`;
    if (!groups.has(key)) {
      groups.set(key, { key, lineId, direction, destinations: [], arrivals: [], bearings: [] });
    }

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

  // Stable line order, then H-side before R-side, prevents rows swapping as
  // individual predictions arrive and expire.
  const directions = [...groups.values()]
    .sort((a, b) => a.lineId.localeCompare(b.lineId) ||
      (a.direction === b.direction ? 0 : a.direction === 'forward' ? -1 : 1))
    .map((group) => {
      return {
        key: group.key,
        line: group.lineId,
        direction: group.direction,
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
    hasRealtime: realtimeArrivals.some((arrival) => arrival.isLive),
    hasScheduled: scheduledArrivals.length > 0,
  };
};

export default getStationFocus;

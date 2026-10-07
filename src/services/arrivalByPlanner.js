import gtfsData from '../data/gtfs_expanded.json';
import { PASSENGER_STATIONS } from './passengerIntelligence';
import { getDirectScheduledSbahnJourneys } from './sbahnSchedule';

const stationByName = new Map(PASSENGER_STATIONS.map((station) => [station.name.toLocaleLowerCase('de-AT'), station]));
const paths = new Map((gtfsData.features || []).filter((feature) => feature.geometry?.type === 'LineString')
  .map((feature) => [feature.properties?.line, feature.geometry.coordinates]));
const terminals = new Map((gtfsData.features || []).filter((feature) => feature.geometry?.type === 'LineString')
  .map((feature) => [feature.properties?.line, feature.properties?.terminals || []]));
const rad = Math.PI / 180;
const metres = ([lonA, latA], [lonB, latB]) => {
  const dLat = (latB - latA) * rad;
  const dLon = (lonB - lonA) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(latA * rad) * Math.cos(latB * rad) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
const nearestIndex = (path, coords) => path.reduce((best, point, index) => {
  const distance = metres(point, coords);
  return distance < best.distance ? { index, distance } : best;
}, { index: 0, distance: Infinity });

export const estimateDirectUbahnTravel = (origin, destination, line) => {
  const from = stationByName.get(String(origin).toLocaleLowerCase('de-AT'));
  const to = stationByName.get(String(destination).toLocaleLowerCase('de-AT'));
  const path = paths.get(line);
  if (!from?.coordinates || !to?.coordinates || !path?.length || !from.lines.includes(line) || !to.lines.includes(line)) return null;
  const first = nearestIndex(path, from.coordinates);
  const last = nearestIndex(path, to.coordinates);
  if (first.index === last.index || first.distance > 450 || last.distance > 450) return null;
  const low = Math.min(first.index, last.index);
  const high = Math.max(first.index, last.index);
  let length = 0;
  for (let index = low + 1; index <= high; index += 1) length += metres(path[index - 1], path[index]);
  const stops = high - low;
  // Geometry and network speed are an experimental range, not the official
  // passenger timetable. The upper bound accounts for dwell and variation.
  const seconds = Math.max(120, Math.round(length / 9.5 + stops * 20));
  const towardsTerminal = (terminals.get(line) || []).map((name) => ({ name, station: stationByName.get(name.toLocaleLowerCase('de-AT')) }))
    .filter((item) => item.station?.coordinates)
    .map((item) => ({ name: item.name, index: nearestIndex(path, item.station.coordinates).index }))
    .sort((a, b) => a.index - b.index);
  const directionTerminal = last.index > first.index ? towardsTerminal.at(-1)?.name : towardsTerminal[0]?.name;
  return { line, seconds, lowSeconds: Math.max(90, Math.round(seconds * 0.82)), highSeconds: Math.round(seconds * 1.25 + 90), stops, directionTerminal, source: 'geometry-and-speed-estimate' };
};

export const buildArrivalByOptions = ({ origin, destination, entries = [], now = Date.now() }) => {
  const from = stationByName.get(String(origin).toLocaleLowerCase('de-AT'));
  const to = stationByName.get(String(destination).toLocaleLowerCase('de-AT'));
  if (!from || !to || from.name === to.name) return [];
  const shared = from.lines.filter((line) => to.lines.includes(line));
  const ubahn = shared.filter((line) => /^U[12346]$/.test(line)).flatMap((line) => {
    const travel = estimateDirectUbahnTravel(origin, destination, line);
    if (!travel) return [];
    return entries.filter((entry) => entry.stationName?.toLocaleLowerCase('de-AT') === from.name.toLocaleLowerCase('de-AT'))
      .flatMap((entry) => entry.arrivals || [])
      .filter((arrival) => arrival.line === line && arrival.isLive && arrival.targetTimestamp >= now && arrival.targetTimestamp <= now + 70 * 60000
        && (!travel.directionTerminal || String(arrival.destination || '').toLocaleLowerCase('de-AT').includes(travel.directionTerminal.toLocaleLowerCase('de-AT'))))
      .slice(0, 3).map((arrival) => ({
        id: `u-${line}-${arrival.targetTimestamp}`, line, departureAt: arrival.targetTimestamp,
        expectedAt: arrival.targetTimestamp + travel.seconds * 1000,
        latestLikelyAt: arrival.targetTimestamp + travel.highSeconds * 1000,
        travelSeconds: travel.seconds, source: 'live departure + estimated line travel',
        scheduled: false, destination: arrival.destination,
      }));
  });
  const sbahn = shared.filter((line) => /^S\d+/.test(line)).length
    ? getDirectScheduledSbahnJourneys(origin, destination, now).slice(0, 4).map((trip) => ({
      ...trip, latestLikelyAt: trip.expectedAt + 5 * 60000,
      travelSeconds: (trip.expectedAt - trip.departureAt) / 1000,
      source: 'ÖBB annual GTFS timetable only', scheduled: true,
    })) : [];
  return [...ubahn, ...sbahn].sort((a, b) => a.departureAt - b.departureAt).slice(0, 8);
};

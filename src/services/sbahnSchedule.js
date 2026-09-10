// Scheduled Vienna S-Bahn positions from ÖBB's annual GTFS timetable.
// ÖBB does not publish vehicle GPS in the Wiener Linien monitor feed, so these
// markers interpolate between scheduled station calls and are labelled as
// timetable estimates everywhere they appear.
import sbahnData from '../data/sbahn_network.json';
import { isSbahnScheduleUsable } from './dataFreshness';

const TIMEZONE = sbahnData.schedule.timezone || 'Europe/Vienna';
const stations = new Map(
  sbahnData.features
    .filter((feature) => feature.geometry.type === 'Point')
    .map((feature) => [feature.properties.stop_id, feature])
);
const stationsByName = new Map([...stations.values()].map((feature) => [
  feature.properties.name.toLowerCase(), feature,
]));
const stationsByApiId = new Map([...stations.values()]
  .filter((feature) => feature.properties.apiId)
  .map((feature) => [Number(feature.properties.apiId), feature]));
const lineMetadata = new Map(
  sbahnData.features
    .filter((feature) => feature.geometry.type === 'LineString')
    .map((feature) => [feature.properties.line, feature.properties])
);
const calendars = new Map(
  sbahnData.schedule.calendars.map((calendar) => [calendar.service, calendar])
);
const exceptions = new Map(
  sbahnData.schedule.exceptions.map(([service, date, type]) => [`${service}|${date}`, type])
);
const scheduleTrips = sbahnData.schedule.trips;
const tripsByStation = new Map();
for (const trip of scheduleTrips) {
  for (const call of trip[5]) {
    if (!tripsByStation.has(call[2])) tripsByStation.set(call[2], []);
    tripsByStation.get(call[2]).push(trip);
  }
}
const activeTripsCache = new Map();

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  weekday: 'short', hourCycle: 'h23',
});
const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export const getViennaServiceClock = (date) => {
  const parts = Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}${parts.month}${parts.day}`,
    weekday: WEEKDAY_INDEX[parts.weekday],
    seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
  };
};

export const isSbahnServiceActive = (service, clock) => {
  const exception = exceptions.get(`${service}|${clock.date}`);
  if (exception === 1) return true;
  if (exception === 2) return false;
  const calendar = calendars.get(service);
  return Boolean(
    calendar && clock.date >= calendar.start && clock.date <= calendar.end &&
    calendar.days[clock.weekday] === 1
  );
};

const activeTrips = (clock) => {
  if (!activeTripsCache.has(clock.date)) {
    activeTripsCache.set(
      clock.date,
      scheduleTrips.filter((trip) => isSbahnServiceActive(trip[2], clock))
    );
  }
  return activeTripsCache.get(clock.date);
};

const bearing = (from, to) => {
  const radians = Math.PI / 180;
  const y = Math.sin((to[0] - from[0]) * radians) * Math.cos(to[1] * radians);
  const x = Math.cos(from[1] * radians) * Math.sin(to[1] * radians) -
    Math.sin(from[1] * radians) * Math.cos(to[1] * radians) *
    Math.cos((to[0] - from[0]) * radians);
  return (Math.atan2(y, x) / radians + 360) % 360;
};

const positionTrip = (trip, serviceDate, serviceSeconds) => {
  const [tripId, line, , direction, destination, calls] = trip;
  const first = calls[0];
  const last = calls.at(-1);
  if (serviceSeconds < first[0] || serviceSeconds > last[1]) return null;

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const station = stations.get(call[2]);
    if (!station) continue;

    if (serviceSeconds <= call[1] || index === calls.length - 1) {
      const upcomingStations = calls.slice(index + 1, index + 4)
        .map((nextCall) => stations.get(nextCall[2])?.properties.name)
        .filter(Boolean);
      return {
        id: `scheduled-${tripId}-${serviceDate}`,
        line,
        direction: destination,
        coordinates: station.geometry.coordinates,
        bearing: index < calls.length - 1
          ? bearing(station.geometry.coordinates, stations.get(calls[index + 1][2]).geometry.coordinates)
          : direction === 0 ? 0 : 180,
        isForward: direction === 0,
        isLive: false,
        isScheduled: true,
        isSimulated: false,
        status: 'At Platform',
        previousStation: index > 0 ? stations.get(calls[index - 1][2])?.properties.name : null,
        targetStation: station.properties.name,
        upcomingStations,
        secondsToTarget: Math.max(0, call[0] - serviceSeconds),
      };
    }

    const nextCall = calls[index + 1];
    if (!nextCall || serviceSeconds > nextCall[0]) continue;
    const nextStation = stations.get(nextCall[2]);
    if (!nextStation) continue;
    const duration = Math.max(1, nextCall[0] - call[1]);
    const progress = Math.max(0, Math.min(1, (serviceSeconds - call[1]) / duration));
    const from = station.geometry.coordinates;
    const to = nextStation.geometry.coordinates;
    const upcomingStations = calls.slice(index + 1, index + 4)
      .map((futureCall) => stations.get(futureCall[2])?.properties.name)
      .filter(Boolean);
    return {
      id: `scheduled-${tripId}-${serviceDate}`,
      line,
      direction: destination,
      coordinates: [from[0] + (to[0] - from[0]) * progress, from[1] + (to[1] - from[1]) * progress],
      bearing: bearing(from, to),
      isForward: direction === 0,
      isLive: false,
      isScheduled: true,
      isSimulated: false,
      status: nextCall[0] - serviceSeconds <= 60 ? 'Approaching' : 'En Route',
      previousStation: station.properties.name,
      targetStation: nextStation.properties.name,
      upcomingStations,
      secondsToTarget: Math.max(0, nextCall[0] - serviceSeconds),
    };
  }
  return null;
};

export const getScheduledSbahnVehicles = (now = Date.now()) => {
  if (!isSbahnScheduleUsable(now)) return [];
  const instant = now instanceof Date ? now : new Date(now);
  const serviceDays = [instant, new Date(instant.getTime() - 86400000)]
    .map((date, index) => {
      const clock = getViennaServiceClock(date);
      return { ...clock, seconds: clock.seconds + index * 86400 };
    });
  const vehicles = [];

  for (const clock of serviceDays) {
    for (const trip of activeTrips(clock)) {
      const vehicle = positionTrip(trip, clock.date, clock.seconds);
      if (vehicle) vehicles.push(vehicle);
    }
  }
  return vehicles;
};

const resolveStation = (stationProps) => {
  if (!stationProps) return null;
  if (Array.isArray(stationProps.lines) && !stationProps.lines.some((line) => String(line).startsWith('S'))) {
    return null;
  }
  if (stationProps.stop_id && stations.has(stationProps.stop_id)) return stations.get(stationProps.stop_id);
  const byName = stationsByName.get(String(stationProps.name || '').toLowerCase());
  if (byName) return byName;
  if (stationProps.apiId && stationsByApiId.has(Number(stationProps.apiId))) {
    return stationsByApiId.get(Number(stationProps.apiId));
  }
  return null;
};

export const getScheduledSbahnArrivals = (stationProps, now = Date.now()) => {
  if (!isSbahnScheduleUsable(now)) return [];
  const station = resolveStation(stationProps);
  if (!station) return [];
  const stationId = station.properties.stop_id;
  const instant = now instanceof Date ? now : new Date(now);
  const nowMs = instant.getTime();
  const serviceDays = [instant, new Date(nowMs - 86400000)]
    .map((date, index) => {
      const clock = getViennaServiceClock(date);
      return { ...clock, seconds: clock.seconds + index * 86400 };
    });
  const arrivals = [];

  for (const trip of tripsByStation.get(stationId) || []) {
    const call = trip[5].find((item) => item[2] === stationId);
    if (!call) continue;
    for (const clock of serviceDays) {
      if (!isSbahnServiceActive(trip[2], clock)) continue;
      const remaining = call[1] - clock.seconds;
      if (remaining < -40 || remaining > 4200) continue;
      const metadata = lineMetadata.get(trip[1]);
      arrivals.push({
        line: trip[1],
        lineName: metadata?.name || trip[1],
        lineColor: metadata?.color || '#00AEEF',
        destination: trip[4],
        directionCode: null,
        targetTimestamp: nowMs + remaining * 1000,
        plannedTargetTimestamp: nowMs + remaining * 1000,
        initialSeconds: Math.max(0, remaining),
        seconds: Math.max(0, remaining),
        minutes: Math.max(0, Math.round(remaining / 60)),
        status: remaining <= 0 ? 'At Platform' : remaining <= 120 ? 'Approaching' : 'On Time',
        isLive: false,
        isScheduled: true,
        tripId: trip[0],
        isCached: true,
        fetchedAt: null,
      });
    }
  }

  return arrivals.sort((a, b) => a.seconds - b.seconds);
};

export const SBAHN_LINES = sbahnData.features
  .filter((feature) => feature.geometry.type === 'LineString')
  .map((feature) => feature.properties.line);

export default getScheduledSbahnVehicles;

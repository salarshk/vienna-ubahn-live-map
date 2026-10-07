import { PASSENGER_STATIONS } from './passengerIntelligence';

const radians = Math.PI / 180;
const distance = ([aLon, aLat], [bLon, bLat]) => {
  const dLat = (bLat - aLat) * radians;
  const dLon = (bLon - aLon) * radians;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * radians) * Math.cos(bLat * radians) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};
const finite = (...values) => values.filter((value) => value != null && value !== '').map(Number).find(Number.isFinite) ?? null;
const coordsFor = (record) => {
  const item = record?.properties || record || {};
  const geometry = record?.geometry?.coordinates;
  const first = Array.isArray(geometry?.[0]) ? geometry[0] : geometry;
  const lon = finite(item.lon, item.longitude, item.lng, first?.[0]);
  const lat = finite(item.lat, item.latitude, first?.[1]);
  return lon > 15 && lon < 18 && lat > 47 && lat < 49 ? [lon, lat] : null;
};
const nearestStation = (coords, tramOnly = false) => PASSENGER_STATIONS
  .filter((station) => station.coordinates && (!tramOnly || station.lines.some((line) => !line.startsWith('U') && !line.startsWith('S'))))
  .map((station) => ({ station, metres: Math.round(distance(coords, station.coordinates)) }))
  .sort((a, b) => a.metres - b.metres)[0] || null;

export const buildRoadworkImpacts = (traffic, now = Date.now()) => {
  if (traffic?.valuesStatus !== 'live') return { status: 'awaiting feed', impacts: [] };
  const impacts = (traffic.observations || []).flatMap((record) => {
    const item = record.properties || record;
    const title = String(item.title || item.name || item.description || item.type || 'Roadwork');
    if (!/roadwork|construction|baustelle|sperre|closure|umleitung/i.test(`${title} ${item.category || ''}`)) return [];
    const coords = coordsFor(record);
    if (!coords) return [];
    const nearest = nearestStation(coords, true);
    if (!nearest || nearest.metres > 650) return [];
    const endAt = Date.parse(item.endAt || item.end || item.validTo || '');
    if (Number.isFinite(endAt) && endAt < now) return [];
    return [{ id: String(item.id || record.id || title), title, station: nearest.station.name, lines: nearest.station.lines, metres: nearest.metres, evidence: 'configured traffic/EVIS feed' }];
  }).slice(0, 8);
  return { status: impacts.length ? 'live' : 'no matched roadworks', impacts };
};

export const buildEventExodus = (events, now = Date.now()) => {
  if (events?.status !== 'live') return { status: 'awaiting feed', events: [] };
  const rows = (events.records || []).flatMap((record) => {
    const item = record.properties || record;
    const endAt = Date.parse(item.endAt || item.end || item.endTime || item.to || '');
    if (!Number.isFinite(endAt) || endAt < now - 15 * 60000 || endAt > now + 2 * 3600000) return [];
    const coords = coordsFor(record);
    if (!coords) return [];
    const nearest = nearestStation(coords);
    if (!nearest || nearest.metres > 1200) return [];
    const attendance = finite(item.attendance, item.expectedAttendance, item.capacity);
    return [{
      id: String(item.id || record.id || `${item.title}-${endAt}`), title: String(item.title || item.name || 'Event'),
      endsAt: endAt, station: nearest.station.name, lines: nearest.station.lines,
      metres: nearest.metres, attendance: attendance && attendance > 0 ? attendance : null,
      status: attendance && attendance >= 1000 ? 'elevated potential' : 'potential',
    }];
  }).sort((a, b) => a.endsAt - b.endsAt).slice(0, 8);
  return { status: rows.length ? 'live' : 'no timed nearby events', events: rows };
};

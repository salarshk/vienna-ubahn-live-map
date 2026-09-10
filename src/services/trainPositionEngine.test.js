import { beforeEach, describe, expect, it } from 'vitest';
import trainPositionEngine, {
  confidenceFromUncertainty,
  estimatePositionUncertainty,
  haversineDistance,
  MIN_POSITION_CONFIDENCE,
  MIN_WALKED_CONFIDENCE,
} from './trainPositionEngine';
import arrivalStore, {
  MAJOR_STATIONS,
  POSITION_SOURCE_IDS,
  STRATEGIC_HUBS,
} from './arrivalStore';
import paradasApi from '../data/paradas_api.json';
import segmentTimes from '../data/segment_times.json';

const LINES = ['U1', 'U2', 'U3', 'U4', 'U6'];
const stationByName = (lineId, name) =>
  trainPositionEngine.getLineStations(lineId).find((station) => station.name === name);
const sourceIdByName = new Map(MAJOR_STATIONS.map((station) => [station.name, station.id]));

const sighting = ({
  key,
  stationName,
  line = 'U1',
  destination = 'Leopoldau',
  directionCode,
  vehicleId,
  secondsFromNow,
  plannedSecondsFromNow = secondsFromNow,
  now,
  fetchedAt = now,
  stationId = sourceIdByName.get(stationName) || key,
}) => {
  arrivalStore.memory.set(key, {
    stationId,
    stationName,
    fetchedAt,
    arrivals: [{
      line,
      destination,
      directionCode,
      vehicleId,
      targetTimestamp: now + secondsFromNow * 1000,
      plannedTargetTimestamp: now + plannedSecondsFromNow * 1000,
      isLive: true,
    }],
  });
};

describe('Vienna network data', () => {
  const stationNameById = new Map(paradasApi.map((station) => [Number(station.id), station.nombre]));

  it.each(STRATEGIC_HUBS)('strategic hub $name has the intended DIVA id', (hub) => {
    expect(stationNameById.get(hub.id)).toBe(hub.name);
  });

  it.each(MAJOR_STATIONS)('network station $name has the intended DIVA id', (station) => {
    expect(stationNameById.get(station.id)).toBe(station.name);
    expect(POSITION_SOURCE_IDS.has(station.id)).toBe(true);
  });

  it('contains exactly the five operating U-Bahn lines', () => {
    expect(LINES.filter((line) => trainPositionEngine.getLineTrack(line))).toEqual(LINES);
    expect(trainPositionEngine.getLineTrack('U5')).toBeUndefined();
  });

  it('keeps each official station chain intact', () => {
    expect(Object.fromEntries(LINES.map((line) => [line, trainPositionEngine.getLineStations(line).length])))
      .toEqual({ U1: 24, U2: 21, U3: 21, U4: 20, U6: 24 });
    expect(trainPositionEngine.offTrackStations).toEqual([]);
  });

  it('keeps the whole network within four stops of a tracking reference', () => {
    for (const line of LINES) {
      const stations = trainPositionEngine.getLineStations(line);
      const sourceIndexes = stations
        .map((station, index) => POSITION_SOURCE_IDS.has(Number(station.apiId)) ? index : -1)
        .filter((index) => index >= 0);
      expect(sourceIndexes[0], `${line} first reference`).toBeLessThanOrEqual(1);
      expect(stations.length - 1 - sourceIndexes.at(-1), `${line} last reference`)
        .toBeLessThanOrEqual(1);
      for (let index = 1; index < sourceIndexes.length; index += 1) {
        expect(sourceIndexes[index] - sourceIndexes[index - 1], `${line} reference gap`)
          .toBeLessThanOrEqual(4);
      }
    }
  });

  it('places every station close to the line it serves', () => {
    for (const line of LINES) {
      for (const station of trainPositionEngine.getLineStations(line)) {
        const { coordinates } = trainPositionEngine
          .getCoordsAndBearingAtDistance(line, station.trackDist, true);
        expect(haversineDistance(station.coords, coordinates), `${line} ${station.name}`)
          .toBeLessThan(200);
      }
    }
  });
});

describe('walking Vienna arrival predictions', () => {
  it.each([
    ['U1', 'Stephansplatz'],
    ['U2', 'Praterstern'],
    ['U3', 'Stephansplatz'],
    ['U4', 'Karlsplatz'],
    ['U6', 'Westbahnhof'],
  ])('uses Wiener Linien H/R direction on %s', (line, stationName) => {
    const station = stationByName(line, stationName);
    expect(trainPositionEngine.resolveDirection(line, 'Unknown', station, 'H')).toBe(true);
    expect(trainPositionEngine.resolveDirection(line, 'Unknown', station, 'R')).toBe(false);
  });

  it('places a train at the reported platform when the countdown is spent', () => {
    const position = trainPositionEngine
      .estimatePositionFromArrival('U1', 'Leopoldau', 'Stephansplatz', 0);
    const station = stationByName('U1', 'Stephansplatz');
    expect(position.status).toBe('At Platform');
    expect(Math.abs(position.distanceAlongTrack - station.trackDist)).toBeLessThan(1);
  });

  it('walks back exactly one segment for one segment of running time', () => {
    const from = stationByName('U1', 'Karlsplatz');
    const to = stationByName('U1', 'Stephansplatz');
    const running = trainPositionEngine.getSegmentSeconds('U1', from, to) - segmentTimes.dwellSeconds;
    const position = trainPositionEngine
      .estimatePositionFromArrival('U1', 'Leopoldau', 'Stephansplatz', running);
    expect(Math.abs(position.distanceAlongTrack - from.trackDist)).toBeLessThan(30);
  });

  it('approaches a station monotonically as its countdown falls', () => {
    const target = stationByName('U1', 'Stephansplatz');
    let previousGap = Infinity;
    for (let seconds = 600; seconds >= 0; seconds -= 30) {
      const position = trainPositionEngine
        .estimatePositionFromArrival('U1', 'Leopoldau', 'Stephansplatz', seconds);
      const gap = Math.abs(position.distanceAlongTrack - target.trackDist);
      expect(gap).toBeLessThanOrEqual(previousGap + 1);
      previousGap = gap;
    }
  });

  it('walks opposite ways for opposite termini', () => {
    const north = trainPositionEngine
      .estimatePositionFromArrival('U1', 'Leopoldau', 'Stephansplatz', 180);
    const south = trainPositionEngine
      .estimatePositionFromArrival('U1', 'Oberlaa', 'Stephansplatz', 180);
    expect(north.isForward).not.toBe(south.isForward);
  });

  it('never runs beyond a line endpoint', () => {
    const track = trainPositionEngine.getLineTrack('U4');
    for (const seconds of [0, 120, 600, 1080, 3600]) {
      const position = trainPositionEngine
        .estimatePositionFromArrival('U4', 'Heiligenstadt', 'Karlsplatz', seconds);
      expect(position.distanceAlongTrack).toBeGreaterThanOrEqual(0);
      expect(position.distanceAlongTrack).toBeLessThanOrEqual(track.totalLength);
    }
  });
});

describe('live vehicle reconstruction', () => {
  beforeEach(() => {
    arrivalStore.memory.clear();
    trainPositionEngine.renderState.clear();
  });

  it('fuses repeated sightings when a vehicle id is available', () => {
    const now = Date.now();
    sighting({ key: 'a', stationName: 'Karlsplatz', vehicleId: '42', secondsFromNow: 60, now });
    sighting({ key: 'b', stationName: 'Stephansplatz', vehicleId: '42', secondsFromNow: 180, now });
    const vehicles = trainPositionEngine.getLiveVehiclesFromMemory(now);
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].sightingCount).toBe(2);
  });

  it('uses the API direction even when a headsign would imply the opposite side', () => {
    const now = Date.now();
    sighting({
      key: 'a', stationName: 'Stephansplatz', destination: 'Leopoldau',
      directionCode: 'R', vehicleId: 'direction-test', secondsFromNow: 120, now,
    });
    const [vehicle] = trainPositionEngine.getLiveVehiclesFromMemory(now);
    expect(vehicle.isForward).toBe(false);
  });

  it('does not let a clicked station re-anchor global train positions', () => {
    const now = Date.now();
    sighting({
      key: 'clicked', stationId: 60209999, stationName: 'Schwedenplatz',
      directionCode: 'H', secondsFromNow: 120, now,
    });
    expect(trainPositionEngine.getLiveVehiclesFromMemory(now)).toEqual([]);
  });

  it('keeps a synthetic train identity stable when its live delay changes', () => {
    const now = Date.now();
    sighting({
      key: 'a', stationName: 'Stephansplatz', directionCode: 'H',
      secondsFromNow: 120, plannedSecondsFromNow: 300, now,
    });
    const firstId = trainPositionEngine.getLiveVehiclesFromMemory(now)[0].id;

    arrivalStore.memory.clear();
    sighting({
      key: 'a', stationName: 'Stephansplatz', directionCode: 'H',
      secondsFromNow: 240, plannedSecondsFromNow: 300, now,
    });
    expect(trainPositionEngine.getLiveVehiclesFromMemory(now)[0].id).toBe(firstId);
  });

  it('never renders a live train moving backward or teleporting', () => {
    const now = Date.now();
    const base = {
      id: 'live-guard', line: 'U1', isLive: true, isForward: true,
      distanceAlongTrack: 1000, coordinates: [16.37, 48.2],
    };
    trainPositionEngine.smoothVehicle(base, now);

    const backward = trainPositionEngine.smoothVehicle(
      { ...base, distanceAlongTrack: 800 }, now + 1000
    );
    expect(backward.distanceAlongTrack).toBe(1000);

    const jump = trainPositionEngine.smoothVehicle(
      { ...base, distanceAlongTrack: 5000 }, now + 2000
    );
    expect(jump.distanceAlongTrack).toBe(1025);
  });

  it('fuses keyless Wiener Linien sightings by their projected terminus time', () => {
    const now = Date.now();
    const karlsplatz = stationByName('U1', 'Karlsplatz');
    const stephansplatz = stationByName('U1', 'Stephansplatz');
    const gap = trainPositionEngine.getSegmentSeconds('U1', karlsplatz, stephansplatz);
    sighting({ key: 'a', stationName: 'Karlsplatz', secondsFromNow: 60, now });
    sighting({ key: 'b', stationName: 'Stephansplatz', secondsFromNow: 60 + gap, now });
    const vehicles = trainPositionEngine.getLiveVehiclesFromMemory(now);
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].sightingCount).toBe(2);
  });

  it('fuses keyless sightings despite small timetable differences', () => {
    const now = Date.now();
    const karlsplatz = stationByName('U1', 'Karlsplatz');
    const stephansplatz = stationByName('U1', 'Stephansplatz');
    const gap = trainPositionEngine.getSegmentSeconds('U1', karlsplatz, stephansplatz);
    sighting({ key: 'a', stationName: 'Karlsplatz', secondsFromNow: 60, now });
    sighting({
      key: 'b', stationName: 'Stephansplatz', secondsFromNow: 60 + gap + 45,
      plannedSecondsFromNow: 60 + gap + 45, now,
    });
    const vehicles = trainPositionEngine.getLiveVehiclesFromMemory(now);
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].sightingCount).toBe(2);
  });

  it('keeps consecutive keyless trains separate', () => {
    const now = Date.now();
    sighting({ key: 'a', stationName: 'Karlsplatz', secondsFromNow: 60, now });
    sighting({ key: 'b', stationName: 'Karlsplatz', secondsFromNow: 285, now });
    expect(trainPositionEngine.getLiveVehiclesFromMemory(now)).toHaveLength(2);
  });

  it('drops predictions too stale or too far ahead to position honestly', () => {
    const now = Date.now();
    sighting({ key: 'a', stationName: 'Karlsplatz', vehicleId: 'old', secondsFromNow: -120, now });
    sighting({ key: 'b', stationName: 'Stephansplatz', vehicleId: 'future', secondsFromNow: 2000, now });
    expect(trainPositionEngine.getLiveVehiclesFromMemory(now)).toEqual([]);
  });

  it('does not draw a future departure before its train has entered the line', () => {
    const now = Date.now();
    sighting({
      key: 'a', stationName: 'Neulaa', destination: 'Leopoldau',
      directionCode: 'H', vehicleId: 'not-started', secondsFromNow: 900, now,
    });
    expect(trainPositionEngine.getLiveVehiclesFromMemory(now)).toEqual([]);
  });

  it('reports confidence and time since the last station sync', () => {
    const now = Date.now();
    sighting({
      key: 'a', stationName: 'Stephansplatz', vehicleId: '42', secondsFromNow: 300,
      now, fetchedAt: now - 240000,
    });
    const [vehicle] = trainPositionEngine.getLiveVehiclesFromMemory(now);
    expect(vehicle.secondsUnheard).toBe(240);
    expect(vehicle.positionConfidence).toBeGreaterThanOrEqual(MIN_POSITION_CONFIDENCE);
    expect(vehicle.positionConfidence).toBeLessThanOrEqual(1);
  });
});

describe('uncertainty and simulation', () => {
  it('provides previous and upcoming stations for train details', () => {
    const stephansplatz = stationByName('U1', 'Stephansplatz');
    const context = trainPositionEngine.getTripContext('U1', stephansplatz.trackDist + 25, true);
    expect(context.previousStation).toBe('Stephansplatz');
    expect(context.upcomingStations.length).toBeGreaterThan(0);
    expect(context.upcomingStations).not.toContain('Stephansplatz');
  });

  it('keeps confidence within the visible design range', () => {
    expect(confidenceFromUncertainty(0)).toBe(1);
    expect(confidenceFromUncertainty(100000)).toBe(MIN_WALKED_CONFIDENCE);
    expect(MIN_POSITION_CONFIDENCE).toBeLessThan(MIN_WALKED_CONFIDENCE);
  });

  it('increases uncertainty with walk length and missed syncs', () => {
    const speed = trainPositionEngine.getLineTrack('U1').fallbackSpeed;
    expect(estimatePositionUncertainty(8, 360, speed))
      .toBeGreaterThan(estimatePositionUncertainty(1, 0, speed));
  });

  it('provides clearly marked timetable simulations when a line has no live data', () => {
    const simulated = trainPositionEngine.getHeadwayVehiclesForLine('U6', Date.now());
    expect(simulated.length).toBeGreaterThan(0);
    expect(simulated.every((vehicle) => vehicle.isSimulated && !vehicle.isLive)).toBe(true);
  });
});

describe('segment timing data', () => {
  it('covers every U-Bahn line with plausible speeds and segments', () => {
    for (const lineId of LINES) {
      const line = segmentTimes.lines[lineId];
      expect(line.segmentCount).toBeGreaterThan(15);
      expect(line.fallback.metresPerSecond).toBeGreaterThan(3);
      expect(line.fallback.metresPerSecond).toBeLessThan(20);
    }
  });

  it('falls back to distance when no explicit segment exists', () => {
    const stations = trainPositionEngine.getLineStations('U1');
    const fabricated = { stopId: 'missing', trackDist: stations[0].trackDist + 800 };
    const seconds = trainPositionEngine.getSegmentSeconds('U1', stations[0], fabricated);
    expect(seconds).toBeGreaterThan(40);
    expect(seconds).toBeLessThan(300);
  });
});

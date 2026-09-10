// Train Position Engine
//
// Answers one question: given the live arrival predictions we hold, where is
// each train right now?
//
// A prediction such as "U1 reaches Stephansplatz in 4 minutes" becomes a
// coordinate by walking backwards along the line from Stephansplatz,
// spending each segment's real timetabled interval, until those 415 seconds are
// used up. The obvious shortcut — multiply the countdown by one commercial
// speed — is wrong in both directions, because real segments run anywhere from
// 3.9 m/s in the dense centre to 16.9 m/s on the northern stretch. At the
// network median of 7.5 m/s the old constant of 10.5 placed every train about
// 40% too far back: roughly two stations of error in the city centre.
import metroData from '../data/metro_lines.json';
import gtfsData from '../data/gtfs_expanded.json';
import segmentTimes from '../data/segment_times.json';
import arrivalStore, { NETWORK_SYNC_INTERVAL_MS, POSITION_SOURCE_IDS } from './arrivalStore';

// Haversine distance in meters
export const haversineDistance = (c1, c2) => {
  const R = 6371000;
  const dLat = (c2[1] - c1[1]) * (Math.PI / 180);
  const dLon = (c2[0] - c1[0]) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(c1[1] * (Math.PI / 180)) * Math.cos(c2[1] * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Project a geographical coordinate onto a polyline to find its cumulative distance along the track
export const projectPointOntoPolyline = (point, coords, cumDists) => {
  let minPerpDist = Infinity;
  let bestDistAlong = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const segLen = cumDists[i + 1] - cumDists[i];
    if (segLen === 0) continue;

    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((point[0] - p1[0]) * dx + (point[1] - p1[1]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const proj = [p1[0] + t * dx, p1[1] + t * dy];
    const d = haversineDistance(point, proj);
    if (d < minPerpDist) {
      minPerpDist = d;
      bestDistAlong = cumDists[i] + t * segLen;
    }
  }

  return { distAlongTrack: bestDistAlong, perpDistance: minPerpDist };
};

const DWELL_SECONDS = segmentTimes.dwellSeconds ?? 25;
const LINE_IDS = (metroData.features || [])
  .filter((feature) => feature.geometry && feature.geometry.type === 'LineString')
  .map((feature) => String(feature.properties.line));

// A prediction this far past its arrival time is stale enough to drop, and one
// this far out has accumulated too much walk error to place with confidence.
const MAX_SECONDS_PAST = 40;
const MAX_SECONDS_AHEAD = 1080;

// A platform must sit close to its line geometry before it participates in the
// walk. This protects the station order if an upstream geometry ever changes.
const MAX_STATION_OFFSET_METRES = 250;

// Rendering must remain physically plausible when the upstream prediction is
// corrected. Vienna U-Bahn trains do not reverse between stations, and 25 m/s
// (90 km/h) is already above normal service speed, so corrections are eased at
// or below this ceiling rather than teleporting a marker.
const MAX_RENDER_SPEED_METRES_PER_SECOND = 25;

// The API has no vehicle or trip id. Timetabled segment sums and the feed's
// planned platform times can differ by a few seconds per stop, so the same
// train observed at distant reference stations does not always land in the
// exact same minute bucket. Ninety seconds joins that accumulated timetable
// error while remaining well below half the normal 3:45 U-Bahn headway.
const SYNTHETIC_TRIP_MATCH_WINDOW_MS = 90000;

// ─── How much to trust a placed train ────────────────────────────────────────
//
// A live marker should look as confident as its position actually is. Two
// things blur that position, and neither is the prediction's age on its own:
// because `targetTimestamp` is an absolute epoch, a prediction sitting in
// memory keeps counting down correctly, and the walk gets *more* accurate as
// the train approaches, because fewer Segment Intervals are left to spend.
//
// 1. Quantisation. The feed states every time to a whole minute, so each
//    Segment Interval the walk spends carries ±30s. Those errors accumulate as
//    a random walk, so n segments cost roughly √n × 30s. This half is measured:
//    it comes straight out of the feed.
// 2. Drift, for the train running late against what the API predicted. Nothing
//    in this repo measures that yet — issue #4 is the live watch that would —
//    so the rate below is calibrated, not derived: it is set so that two missed
//    Network Syncs cost about what a full-length countdown costs on a median
//    line, the two states issue #7's table puts at the same opacity. Revisit it
//    with real numbers rather than treating it as measured.
//    Seconds inside one Network Sync interval are the healthy cadence and cost
//    nothing.
//
// Both terms are seconds of doubt, converted to metres at the Line's Commercial
// Speed. That puts one segment on line 6 (the slowest at 4.1 m/s) at 123 m, and
// a nine-segment full-countdown walk on line 1 (11.01 m/s) at 991 m — the two
// ends of the range this network spans.
const QUANTISATION_SECONDS = 30;
const DRIFT_SECONDS_PER_SECOND_UNHEARD = 0.25;

// Below this a position is as good as this model gets — one segment on a median
// line is about 200 m — so it costs no confidence. A walked position bottoms
// out at 1 km of doubt.
const FULL_CONFIDENCE_METRES = 200;
const LOST_CONFIDENCE_METRES = 1000;

// Two floors, because they are two different claims. A walked position, however
// long the walk, still rests on a prediction the API actually made; Dead
// Reckoning does not. Keeping them apart means a dead-reckoned train reads as
// the faintest thing on the map on every line — without it, a full-countdown
// train on line 1 (991 m of doubt) is already indistinguishable from one that
// has run out of prediction entirely.
export const MIN_WALKED_CONFIDENCE = 0.45;

// A train whose position is a guess must still be visible: it should read as
// uncertain, not absent.
export const MIN_POSITION_CONFIDENCE = 0.35;

/**
 * Metres of doubt around a walked position.
 */
export const estimatePositionUncertainty = (segmentsWalked, secondsUnheard, metresPerSecond) => {
  const quantisation = Math.sqrt(Math.max(0, segmentsWalked)) * QUANTISATION_SECONDS;
  const beyondOneSync = Math.max(0, secondsUnheard - NETWORK_SYNC_INTERVAL_MS / 1000);
  const drift = beyondOneSync * DRIFT_SECONDS_PER_SECOND_UNHEARD;
  return (quantisation + drift) * metresPerSecond;
};

/**
 * The 0.45–1 scale a walked position is drawn at. Dead Reckoning does not come
 * through here: it has no walk to size, and sits at MIN_POSITION_CONFIDENCE.
 */
export const confidenceFromUncertainty = (uncertaintyMetres) => {
  const span = LOST_CONFIDENCE_METRES - FULL_CONFIDENCE_METRES;
  const lost = (uncertaintyMetres - FULL_CONFIDENCE_METRES) / span;
  return Math.max(MIN_WALKED_CONFIDENCE, Math.min(1, 1 - lost));
};

const normalise = (value) => (value || '').toLowerCase().trim();

// Wiener Linien reports each departure's operational direction as H or R.
// H is line-relative rather than a compass heading, so anchor it to the known
// H-side terminus for each current U-Bahn line instead of assuming that every
// imported geometry will always have the same orientation.
const H_DIRECTION_TERMINUS = {
  U1: 'Leopoldau',
  U2: 'Karlsplatz',
  U3: 'Simmering',
  U4: 'Heiligenstadt',
  U6: 'Floridsdorf',
};

class TrainPositionEngine {
  constructor() {
    this.lineTracks = new Map();
    this.lineStations = new Map();
    // Stations a line serves but its geometry cannot reach; trains bound for
    // these hold at the nearest terminus rather than being drawn off-track.
    this.offTrackStations = [];
    // Per-vehicle render position, so a fresh fetch eases the marker to its new
    // anchor instead of teleporting it.
    this.renderState = new Map();
    this.init();
  }

  init() {
    const allStationPoints = (gtfsData.features || []).filter(
      f => f.geometry && f.geometry.type === 'Point'
    );

    for (const lineId of LINE_IDS) {
      const feature = (metroData.features || []).find(
        f => f.properties && f.properties.line === lineId && f.geometry && f.geometry.type === 'LineString'
      );
      if (!feature) continue;

      const coords = feature.geometry.coordinates;
      if (!coords || coords.length < 2) continue;

      // 1. Calculate cumulative track distances
      const cumDists = [0];
      for (let i = 1; i < coords.length; i++) {
        cumDists.push(cumDists[i - 1] + haversineDistance(coords[i - 1], coords[i]));
      }
      const totalLength = cumDists[cumDists.length - 1] || 1;

      const timing = segmentTimes.lines[lineId] || {};
      this.lineTracks.set(lineId, {
        coords,
        cumDists,
        totalLength,
        segments: timing.segments || {},
        // Only used where the timetable has no entry for a segment.
        fallbackSpeed: (timing.fallback || segmentTimes.networkFallback).metresPerSecond,
        minSegmentSeconds: (timing.fallback || segmentTimes.networkFallback).minSeconds ?? DWELL_SECONDS + 15,
        color: feature.properties.color || '#888888',
        name: feature.properties.name || `Line ${lineId}`,
      });

      // 2. Project stations serving this line
      const stationsForLine = allStationPoints.filter(
        st => Array.isArray(st.properties.lines) && st.properties.lines.includes(lineId)
      );

      const projectedStations = stationsForLine.map((st) => {
        const proj = projectPointOntoPolyline(st.geometry.coordinates, coords, cumDists);
        return {
          id: st.properties.id,
          stopId: st.properties.stop_id || null,
          apiId: st.properties.apiId || null,
          name: st.properties.name,
          coords: st.geometry.coordinates,
          trackDist: proj.distAlongTrack,
          offTrackMetres: proj.perpDistance,
        };
      });

      for (const station of projectedStations) {
        if (station.offTrackMetres > MAX_STATION_OFFSET_METRES) {
          this.offTrackStations.push({
            line: lineId,
            name: station.name,
            metres: Math.round(station.offTrackMetres),
          });
        }
      }

      this.lineStations.set(lineId, projectedStations
        .filter(st => st.offTrackMetres <= MAX_STATION_OFFSET_METRES)
        .sort((a, b) => a.trackDist - b.trackDist));
    }
  }

  getLineTrack(lineId) {
    return this.lineTracks.get(String(lineId));
  }

  getLineStations(lineId) {
    return this.lineStations.get(String(lineId)) || [];
  }

  /**
   * Seconds between arriving at one station and arriving at the next, taken
   * from the timetable where it exists. Includes the dwell at the origin.
   */
  getSegmentSeconds(lineId, from, to) {
    const track = this.getLineTrack(lineId);
    if (!track) return DWELL_SECONDS + 60;

    if (from.stopId && to.stopId) {
      const forward = track.segments[`${from.stopId}>${to.stopId}`];
      if (forward) return forward;
      // Timetables are directional but running times are near-symmetric, and
      // some segments are only ever served one way in the feed.
      const reverse = track.segments[`${to.stopId}>${from.stopId}`];
      if (reverse) return reverse;
    }

    const metres = Math.abs(to.trackDist - from.trackDist);
    return Math.max(track.minSegmentSeconds, Math.round(metres / track.fallbackSpeed));
  }

  /**
   * [lng, lat] and bearing at a distance along the track.
   */
  getCoordsAndBearingAtDistance(lineId, distanceMeters, isForward = true) {
    const track = this.getLineTrack(lineId);
    if (!track) return { coordinates: [0, 0], bearing: 0 };

    const dist = Math.max(0, Math.min(track.totalLength, distanceMeters));
    const { coords, cumDists } = track;

    // Binary search for segment
    let low = 0;
    let high = cumDists.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cumDists[mid] <= dist) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const idx = Math.max(0, Math.min(coords.length - 2, high));
    const segStartDist = cumDists[idx];
    const segEndDist = cumDists[idx + 1];
    const segLen = segEndDist - segStartDist;
    const t = segLen > 0 ? (dist - segStartDist) / segLen : 0;

    const p1 = coords[idx];
    const p2 = coords[idx + 1];
    const lng = p1[0] + t * (p2[0] - p1[0]);
    const lat = p1[1] + t * (p2[1] - p1[1]);

    // Bearing
    const dx = isForward ? (p2[0] - p1[0]) : (p1[0] - p2[0]);
    const dy = isForward ? (p2[1] - p1[1]) : (p1[1] - p2[1]);
    const rad = Math.atan2(dx, dy);
    const bearing = (rad * 180 / Math.PI + 360) % 360;

    return { coordinates: [lng, lat], bearing };
  }

  findStation(lineId, stationName) {
    const stations = this.getLineStations(lineId);
    const target = normalise(stationName);
    if (!target) return null;

    const exact = stations.find(s => normalise(s.name) === target);
    if (exact) return exact;

    return stations.find(
      s => normalise(s.name).includes(target) || target.includes(normalise(s.name))
    ) || null;
  }

  /** Timetabled seconds between two stations on one line. */
  getSecondsBetweenStations(lineId, from, to) {
    const stations = this.getLineStations(lineId);
    const fromIndex = stations.findIndex((station) => station.id === from.id);
    const toIndex = stations.findIndex((station) => station.id === to.id);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return 0;

    const step = toIndex > fromIndex ? 1 : -1;
    let seconds = 0;
    for (let index = fromIndex; index !== toIndex; index += step) {
      seconds += this.getSegmentSeconds(lineId, stations[index], stations[index + step]);
    }
    return seconds;
  }

  /**
   * Which way along the track is this train travelling?
   *
   * The headsign is a real station name, so locating it on the line gives the
   * answer directly; the terminus checks are only there for the handful of
   * headsigns that name a station on a branch this polyline does not cover.
   */
  resolveDirection(lineId, destination, target, directionCode = null) {
    const stations = this.getLineStations(lineId);
    if (stations.length < 2 || !target) return true;

    const code = String(directionCode || '').toUpperCase();
    if (code === 'H' || code === 'R') {
      const hTerminus = this.findStation(lineId, H_DIRECTION_TERMINUS[lineId]);
      const midpoint = (stations[0].trackDist + stations[stations.length - 1].trackDist) / 2;
      const hIsForward = hTerminus ? hTerminus.trackDist > midpoint : true;
      return code === 'H' ? hIsForward : !hIsForward;
    }

    const destination_ = this.findStation(lineId, destination);
    if (destination_ && destination_.trackDist !== target.trackDist) {
      return destination_.trackDist > target.trackDist;
    }

    const normDest = normalise(destination);
    const firstStop = stations[0];
    const lastStop = stations[stations.length - 1];
    if (normDest && normalise(firstStop.name).startsWith(normDest.slice(0, 4))) return false;
    if (normDest && normalise(lastStop.name).startsWith(normDest.slice(0, 4))) return true;

    return true;
  }

  /**
   * Walk the station chain to place a train that is `secondsToTarget` away from
   * `target`, spending each segment's timetabled interval on the way.
   *
   * A negative countdown means the train has already called at the target and
   * is walked forwards instead.
   *
   * Reports `segmentsWalked` alongside the position, counting a part-crossed
   * segment as the fraction of it spent. That is what the ±30s each Segment
   * Interval carries accumulates over, so it is what sizes the uncertainty the
   * marker is drawn with.
   *
   * Also reports whether it ended up Dead Reckoning: walking on past a spent
   * countdown with no prediction left. Sitting out a Station Dwell at the
   * target is not that — the train is where it was reported to be — so the
   * distinction is the walk's to make, not something a caller can read off the
   * sign of the countdown.
   */
  walkFromStation(lineId, target, secondsToTarget, isForward) {
    const track = this.getLineTrack(lineId);
    const stations = this.getLineStations(lineId);
    if (!track || !target) return null;

    const targetIndex = stations.findIndex(s => s.id === target.id);
    if (targetIndex < 0) return null;

    // Walking backwards from the target means stepping against the direction of
    // travel; walking forwards from it means stepping with the direction.
    const stepBack = isForward ? -1 : 1;
    let segmentsWalked = 0;

    if (secondsToTarget <= 0) {
      let remaining = -secondsToTarget;
      // Still inside the dwell it was predicted to arrive for: the train is at
      // the platform the API named, which is the best-known position there is.
      if (remaining <= DWELL_SECONDS) {
        return { trackDist: target.trackDist, status: 'At Platform', nextStation: target, segmentsWalked, isDeadReckoned: false };
      }
      remaining -= DWELL_SECONDS;

      let fromIndex = targetIndex;
      while (true) {
        const toIndex = fromIndex - stepBack;
        if (toIndex < 0 || toIndex >= stations.length) {
          return { trackDist: stations[fromIndex].trackDist, status: 'At Terminus', nextStation: stations[fromIndex], segmentsWalked, isDeadReckoned: true };
        }
        const from = stations[fromIndex];
        const to = stations[toIndex];
        const running = Math.max(1, this.getSegmentSeconds(lineId, from, to) - DWELL_SECONDS);

        if (remaining <= running) {
          const progress = remaining / running;
          return {
            trackDist: from.trackDist + (to.trackDist - from.trackDist) * progress,
            status: 'En Route',
            nextStation: to,
            segmentsWalked: segmentsWalked + progress,
            isDeadReckoned: true,
          };
        }
        remaining -= running;
        segmentsWalked += 1;
        if (remaining <= DWELL_SECONDS) {
          return { trackDist: to.trackDist, status: 'At Platform', nextStation: to, segmentsWalked, isDeadReckoned: true };
        }
        remaining -= DWELL_SECONDS;
        fromIndex = toIndex;
      }
    }

    let remaining = secondsToTarget;
    let arrivalIndex = targetIndex;

    while (true) {
      const departureIndex = arrivalIndex + stepBack;
      if (departureIndex < 0 || departureIndex >= stations.length) {
        // The prediction reaches further back than the origin of this trip.
        // Keep the public estimator bounded for direct callers, but flag it:
        // the later departure is not a train running on the line yet and must
        // not become another marker piled onto the terminus.
        return {
          trackDist: stations[arrivalIndex].trackDist,
          status: 'At Terminus',
          nextStation: stations[targetIndex],
          segmentsWalked,
          isDeadReckoned: false,
          isPreDeparture: true,
        };
      }

      const departure = stations[departureIndex];
      const arrival = stations[arrivalIndex];
      const running = Math.max(1, this.getSegmentSeconds(lineId, departure, arrival) - DWELL_SECONDS);

      if (remaining <= running) {
        const progress = 1 - remaining / running;
        return {
          trackDist: departure.trackDist + (arrival.trackDist - departure.trackDist) * progress,
          status: remaining <= 60 ? 'Approaching' : 'En Route',
          nextStation: arrival,
          segmentsWalked: segmentsWalked + (1 - progress),
          isDeadReckoned: false,
        };
      }

      remaining -= running;
      segmentsWalked += 1;
      if (remaining <= DWELL_SECONDS) {
        return { trackDist: departure.trackDist, status: 'At Platform', nextStation: arrival, segmentsWalked, isDeadReckoned: false };
      }
      remaining -= DWELL_SECONDS;
      arrivalIndex = departureIndex;
    }
  }

  /**
   * Position a train from one arrival prediction.
   */
  estimatePositionFromArrival(
    lineId, destination, targetStationName, secondsToTarget, directionCode = null
  ) {
    const stations = this.getLineStations(lineId);
    if (!this.getLineTrack(lineId) || stations.length === 0) return null;

    const target = this.findStation(lineId, targetStationName);
    if (!target) return null;

    const isForward = this.resolveDirection(lineId, destination, target, directionCode);
    const walked = this.walkFromStation(lineId, target, secondsToTarget, isForward);
    if (!walked) return null;

    const { coordinates, bearing } = this.getCoordsAndBearingAtDistance(lineId, walked.trackDist, isForward);
    return {
      coordinates,
      bearing,
      distanceAlongTrack: walked.trackDist,
      isForward,
      status: walked.status,
      targetStation: target.name,
      nextStation: walked.nextStation ? walked.nextStation.name : target.name,
      secondsToTarget: Math.round(secondsToTarget),
    };
  }

  /**
   * Gather every sighting of every vehicle across all cached stations.
   *
   * The same train is routinely predicted at several stations at once. Each
   * sighting is a separate constraint on where it is, and the nearest one in
   * time is the most reliable, because walk error grows with the countdown.
   */
  collectVehicleSightings(now) {
    const byVehicle = new Map();
    const syntheticByService = new Map();

    for (const [, entry] of arrivalStore.memory.entries()) {
      if (!entry || !Array.isArray(entry.arrivals)) continue;
      if (!POSITION_SOURCE_IDS.has(Number(entry.stationId))) continue;

      // When we last heard from the API about this station. Not how old the
      // countdown is — that stays honest on its own — but how long the train
      // has had to drift from the prediction unobserved.
      const fetchedAt = Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : now;

      for (const arrival of entry.arrivals) {
        if (!arrival.isLive || !arrival.targetTimestamp) continue;

        const secondsRemaining = (arrival.targetTimestamp - now) / 1000;
        if (secondsRemaining < -MAX_SECONDS_PAST || secondsRemaining > MAX_SECONDS_AHEAD) continue;

        const lineId = String(arrival.line);
        const station = this.findStation(lineId, entry.stationName);
        if (!station) continue;

        // Wiener Linien does not normally expose a vehicle number. Projecting
        // each sighting forward to its destination produces a stable trip slot
        // that can join the same train seen at two different stations.
        const destinationStation = this.findStation(lineId, arrival.destination);
        // Planned times identify a trip more stably than real-time predictions,
        // which move whenever the estimated delay changes. Real time still
        // controls the position; planned time is used only for synthetic IDs.
        const identityTimestamp = arrival.plannedTargetTimestamp || arrival.targetTimestamp;
        const destinationTimestamp = destinationStation
          ? identityTimestamp + this.getSecondsBetweenStations(
            lineId, station, destinationStation
          ) * 1000
          : identityTimestamp;
        const sighting = { station, secondsRemaining, fetchedAt };
        if (arrival.vehicleId) {
          const key = `${lineId}-${arrival.vehicleId}`;
          if (!byVehicle.has(key)) {
            byVehicle.set(key, {
              key,
              lineId,
              vehicleId: arrival.vehicleId,
              destination: arrival.destination,
              directionCode: arrival.directionCode || null,
              sightings: [],
            });
          }
          byVehicle.get(key).sightings.push(sighting);
          continue;
        }

        const serviceKey = `${lineId}|${arrival.directionCode || 'unknown'}|${arrival.destination}`;
        if (!syntheticByService.has(serviceKey)) syntheticByService.set(serviceKey, []);
        syntheticByService.get(serviceKey).push({
          lineId,
          destination: arrival.destination,
          directionCode: arrival.directionCode || null,
          destinationTimestamp,
          sighting,
        });
      }
    }

    // Cluster keyless sightings by their projected planned time at the
    // destination. This is the closest stable trip identity the feed exposes.
    for (const [serviceKey, candidates] of syntheticByService) {
      candidates.sort((a, b) => a.destinationTimestamp - b.destinationTimestamp);
      const clusters = [];

      for (const candidate of candidates) {
        let cluster = clusters.find((item) =>
          Math.abs(candidate.destinationTimestamp - item.centreTimestamp)
            <= SYNTHETIC_TRIP_MATCH_WINDOW_MS
        );
        if (!cluster) {
          cluster = { centreTimestamp: candidate.destinationTimestamp, candidates: [] };
          clusters.push(cluster);
        }
        cluster.candidates.push(candidate);
        const orderedTimes = cluster.candidates
          .map((item) => item.destinationTimestamp)
          .sort((a, b) => a - b);
        cluster.centreTimestamp = orderedTimes[Math.floor(orderedTimes.length / 2)];
      }

      for (const cluster of clusters) {
        const first = cluster.candidates[0];
        const tripSlot = Math.round(cluster.centreTimestamp / 15000);
        const key = `${serviceKey}|${tripSlot}`;
        byVehicle.set(key, {
          key,
          lineId: first.lineId,
          vehicleId: null,
          destination: first.destination,
          directionCode: first.directionCode,
          sightings: cluster.candidates.map((candidate) => candidate.sighting),
        });
      }
    }

    return byVehicle;
  }

  /**
   * Extract real-time trains from arrival memory.
   */
  getLiveVehiclesFromMemory(now = Date.now()) {
    const vehicles = [];

    for (const train of this.collectVehicleSightings(now).values()) {
      const sightings = train.sightings.sort(
        (a, b) => Math.abs(a.secondsRemaining) - Math.abs(b.secondsRemaining)
      );
      const anchor = sightings[0];

      // The feed's H/R value is authoritative. Older cached entries without it
      // retain the two-sighting inference as a backwards-compatible fallback.
      let isForward = this.resolveDirection(
        train.lineId, train.destination, anchor.station, train.directionCode
      );
      if (!train.directionCode) {
        const other = sightings.find(s => s.station.trackDist !== anchor.station.trackDist);
        if (other) {
          const laterStation = other.secondsRemaining > anchor.secondsRemaining ? other : anchor;
          const earlierStation = laterStation === other ? anchor : other;
          isForward = laterStation.station.trackDist > earlierStation.station.trackDist;
        }
      }

      const walked = this.walkFromStation(
        train.lineId, anchor.station, anchor.secondsRemaining, isForward
      );
      if (!walked || walked.isPreDeparture) continue;

      const { coordinates, bearing } = this.getCoordsAndBearingAtDistance(
        train.lineId, walked.trackDist, isForward
      );

      const secondsUnheard = Math.max(0, (now - anchor.fetchedAt) / 1000);
      const uncertaintyMetres = estimatePositionUncertainty(
        walked.segmentsWalked, secondsUnheard, this.getLineTrack(train.lineId).fallbackSpeed
      );
      // Dead Reckoning is the sharpest loss of confidence there is, and it is
      // not about age at all — a prediction fetched a second ago can already be
      // in it — so it goes straight to the floor rather than through the walk's
      // own scale.
      const { isDeadReckoned } = walked;

      vehicles.push({
        id: `live-${train.key}`,
        line: train.lineId,
        vehicleId: train.vehicleId,
        direction: train.destination,
        coordinates,
        bearing,
        distanceAlongTrack: walked.trackDist,
        isForward,
        isLive: true,
        status: walked.status,
        sightingCount: sightings.length,
        positionUncertaintyMetres: Math.round(uncertaintyMetres),
        positionConfidence: isDeadReckoned
          ? MIN_POSITION_CONFIDENCE
          : confidenceFromUncertainty(uncertaintyMetres),
        isDeadReckoned,
        secondsUnheard: Math.round(secondsUnheard),
        targetStation: walked.nextStation ? walked.nextStation.name : anchor.station.name,
        secondsToTarget: Math.max(0, Math.round(anchor.secondsRemaining)),
      });
    }

    return vehicles;
  }

  /**
   * Headway simulation for lines with no live data. These are not real trains
   * and callers must present them as such.
   */
  getHeadwayVehiclesForLine(lineId, now = Date.now()) {
    const track = this.getLineTrack(lineId);
    const stations = this.getLineStations(lineId);
    if (!track || stations.length < 2) return [];

    const firstStop = stations[0];
    const lastStop = stations[stations.length - 1];
    const totalLength = track.totalLength;
    const speed = track.fallbackSpeed;

    // One round-trip cycle duration in milliseconds
    const oneWaySecs = totalLength / speed;
    const cycleTimeMs = Math.max(600000, oneWaySecs * 1000 * 2.2);

    // Number of trains per direction based on line length
    const numTrainsPerDir = totalLength > 40000 ? 3 : (totalLength > 15000 ? 2 : 1);
    const vehicles = [];

    for (let dir = 0; dir < 2; dir++) {
      const isForward = dir === 0;
      const destination = isForward ? lastStop.name : firstStop.name;

      for (let tIdx = 0; tIdx < numTrainsPerDir; tIdx++) {
        const offsetMs = (cycleTimeMs / numTrainsPerDir) * tIdx + (dir * (cycleTimeMs / (numTrainsPerDir * 2)));
        const cycleProgress = (((now + offsetMs) % cycleTimeMs) / cycleTimeMs);

        // Ping-pong smoothly along the line
        const posProgress = cycleProgress > 0.5 ? (1 - cycleProgress) * 2 : cycleProgress * 2;
        const currentDist = posProgress * totalLength;

        // Determine nearest upcoming station
        let nearestTarget = isForward ? lastStop : firstStop;
        for (const st of stations) {
          if (isForward && st.trackDist >= currentDist) {
            nearestTarget = st;
            break;
          } else if (!isForward && st.trackDist <= currentDist) {
            nearestTarget = st;
            break;
          }
        }

        const remainingDist = Math.abs(nearestTarget.trackDist - currentDist);
        const secondsToTarget = Math.round(remainingDist / speed);

        const { coordinates, bearing } = this.getCoordsAndBearingAtDistance(lineId, currentDist, isForward);

        vehicles.push({
          id: `sim-L${lineId}-${isForward ? 'fwd' : 'rev'}-${tIdx}`,
          line: lineId,
          direction: destination,
          coordinates,
          bearing,
          distanceAlongTrack: currentDist,
          isForward,
          isLive: false,
          isSimulated: true,
          targetStation: nearestTarget.name,
          secondsToTarget,
        });
      }
    }

    return vehicles;
  }

  /**
   * Ease a marker towards its computed position so a fresh fetch does not make
   * it jump. Live trains only: simulated ones are already continuous.
   */
  smoothVehicle(vehicle, now) {
    if (!vehicle.isLive) return vehicle;

    const previous = this.renderState.get(vehicle.id);
    if (!previous) {
      this.renderState.set(vehicle.id, {
        trackDist: vehicle.distanceAlongTrack,
        at: now,
      });
      return vehicle;
    }

    const sign = vehicle.isForward === false ? -1 : 1;
    const elapsedSeconds = Math.max(0, (now - previous.at) / 1000);
    const requestedAdvance = (vehicle.distanceAlongTrack - previous.trackDist) * sign;
    // Never render an upstream correction as a train physically reversing.
    // Hold its last position until the corrected estimate catches up.
    const forwardAdvance = Math.max(0, requestedAdvance);
    const maxAdvance = MAX_RENDER_SPEED_METRES_PER_SECOND * elapsedSeconds;
    const appliedAdvance = Math.min(forwardAdvance, maxAdvance);
    const eased = previous.trackDist + sign * appliedAdvance;
    const { coordinates, bearing } = this.getCoordsAndBearingAtDistance(
      vehicle.line, eased, vehicle.isForward !== false
    );

    this.renderState.set(vehicle.id, { trackDist: eased, at: now });
    return { ...vehicle, coordinates, bearing, distanceAlongTrack: eased };
  }

  /**
   * Main entry point: live trains where we have predictions, headway trains
   * elsewhere.
   */
  getAllVehicles(now = Date.now()) {
    const liveVehicles = this.getLiveVehiclesFromMemory(now);
    const allVehicles = [...liveVehicles];

    for (const lineId of LINE_IDS) {
      const liveOnLine = liveVehicles.filter(v => v.line === lineId);

      if (liveOnLine.length === 0) {
        allVehicles.push(...this.getHeadwayVehiclesForLine(lineId, now));
      } else if (liveOnLine.length === 1) {
        // Add opposite direction headway train
        const simulated = this.getHeadwayVehiclesForLine(lineId, now);
        const oppSim = simulated.find(s => s.direction !== liveOnLine[0].direction);
        if (oppSim) allVehicles.push(oppSim);
      }
    }

    // Drop render state for trains that are no longer on the map.
    const alive = new Set(allVehicles.map(v => v.id));
    for (const id of this.renderState.keys()) {
      if (!alive.has(id)) this.renderState.delete(id);
    }

    return allVehicles.map(v => this.smoothVehicle(v, now));
  }
}

export const trainPositionEngine = new TrainPositionEngine();
export default trainPositionEngine;

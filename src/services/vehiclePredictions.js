import { incidentContextForLine, predictFinalDelay, predictOnlineDelay } from './delayModel';

const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));
const round = (value, digits = 1) => Number(Number(value).toFixed(digits));
const normalise = (value) => String(value || '').trim().toLowerCase();

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * Join an inferred train marker to the closest official departure observation.
 * The Wiener Linien feed does not expose a stable vehicle number for every
 * train, so station, destination and countdown are used as a conservative
 * trip match instead of pretending this is an exact vehicle identity.
 */
export const matchVehicleArrival = ({ vehicle, arrivals = [] } = {}) => {
  if (!vehicle || !Array.isArray(arrivals)) return null;
  const line = normalise(vehicle.line);
  const target = normalise(vehicle.targetStation);
  const destination = normalise(vehicle.direction);
  const secondsToTarget = finite(vehicle.secondsToTarget);
  const candidates = arrivals
    .filter((arrival) => normalise(arrival.line) === line)
    .map((arrival) => {
      const stationMatch = target && normalise(arrival.stationName) === target;
      const destinationMatch = destination && normalise(arrival.destination) === destination;
      const seconds = finite(arrival.seconds);
      const countdownDistance = secondsToTarget !== null && seconds !== null
        ? Math.abs(seconds - secondsToTarget)
        : 60;
      // A station/destination match is substantially stronger than a nearby
      // countdown because several trains on one line can share a time window.
      const score = (stationMatch ? 100 : 0) + (destinationMatch ? 35 : 0)
        - Math.min(45, countdownDistance / 12);
      return { arrival, score };
    })
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.score >= 0 ? candidates[0].arrival : null;
};

const delayFromArrival = (arrival) => {
  const reported = finite(arrival?.reportedDelaySeconds);
  if (reported !== null) return reported / 60;
  const target = finite(arrival?.targetTimestamp);
  const planned = finite(arrival?.plannedTargetTimestamp);
  return target !== null && planned !== null ? (target - planned) / 60000 : null;
};

/**
 * Per-train delay forecast for the next station. It uses the published model
 * when healthy, then online calibration, and finally a transparent live
 * baseline. The result is deliberately an interval because marker positions
 * are inferred from departures rather than guaranteed GPS fixes.
 */
export const predictVehicleDelay = ({
  vehicle,
  arrivals = [],
  disruptions = [],
  modelSnapshot = null,
  now = Date.now(),
} = {}) => {
  const arrival = matchVehicleArrival({ vehicle, arrivals });
  const official = finite(vehicle?.officialDelaySeconds);
  const currentMinutes = official !== null ? official / 60 : delayFromArrival(arrival);
  const context = arrival
    ? { ...arrival, ...incidentContextForLine(disruptions, vehicle.line, now) }
    : null;
  const model = modelSnapshot?.model;
  const modelMinutes = context ? predictFinalDelay(model, context, now) : null;
  const onlineMinutes = context ? predictOnlineDelay(model, context) : null;
  const predictedMinutes = modelMinutes ?? onlineMinutes ?? currentMinutes;
  const confidenceBase = finite(vehicle?.positionConfidence);
  const uncertaintyMetres = finite(vehicle?.positionUncertaintyMetres) || 0;
  const observationAge = finite(vehicle?.secondsUnheard) || 0;
  const confidence = predictedMinutes === null
    ? 0
    : clamp(Math.round((confidenceBase ?? 0.45) * 100 - uncertaintyMetres / 35 - observationAge / 30), 20, 96);
  const spread = predictedMinutes === null
    ? null
    : round(clamp(0.6 + uncertaintyMetres / 180 + (arrival ? 0 : 1.2), 0.8, 8), 1);
  const source = modelMinutes !== null
    ? 'trained delay model'
    : onlineMinutes !== null
      ? 'online-calibrated delay model'
      : currentMinutes !== null
        ? official !== null ? 'official delay carried forward' : 'live delay baseline'
        : 'not enough live timing data';
  return {
    station: vehicle?.targetStation || arrival?.stationName || 'next station',
    currentMinutes: currentMinutes === null ? null : round(currentMinutes),
    predictedMinutes: predictedMinutes === null ? null : round(clamp(predictedMinutes, -2, 30)),
    lowMinutes: spread === null ? null : round(clamp(predictedMinutes - spread, -2, 30)),
    highMinutes: spread === null ? null : round(clamp(predictedMinutes + spread, -2, 30)),
    confidence,
    source,
    matchedOfficialObservation: Boolean(arrival),
    evidence: arrival
      ? `${arrival.stationName || 'official stop'} timing + inferred train position`
      : 'No matching official stop observation in the local cache',
  };
};

/**
 * Predict the stop dwell for the clicked train. Wiener Linien does not publish
 * a per-vehicle dwell forecast, so this is a line-aware baseline adjusted by
 * platform status and position uncertainty, clearly labelled as inferred.
 */
export const predictVehicleDwell = ({ vehicle } = {}) => {
  if (!vehicle) return null;
  const uncertaintyMetres = finite(vehicle.positionUncertaintyMetres) || 0;
  const observationAge = finite(vehicle.secondsUnheard) || 0;
  const lineBaseline = { U1: 0.8, U2: 0.9, U3: 0.8, U4: 0.9, U6: 1.0 }[vehicle.line] || 0.9;
  const atPlatform = vehicle.status === 'At Platform';
  const platformAdjustment = atPlatform ? 0.25 : 0;
  const predictedMinutes = round(clamp(lineBaseline + platformAdjustment + uncertaintyMetres / 2400 + observationAge / 1800, 0.5, 4));
  const spread = round(clamp(0.25 + uncertaintyMetres / 1800 + observationAge / 900, 0.3, 2.5));
  const confidence = clamp(Math.round((finite(vehicle.positionConfidence) ?? 0.45) * 100 - uncertaintyMetres / 40 - observationAge / 35), 20, 94);
  return {
    station: vehicle.targetStation || 'next station',
    predictedMinutes,
    lowMinutes: round(Math.max(0.3, predictedMinutes - spread)),
    highMinutes: round(predictedMinutes + spread),
    confidence,
    status: atPlatform ? 'remaining platform dwell' : 'dwell at next station',
    source: 'inferred dwell baseline',
    evidence: atPlatform
      ? 'platform status + line baseline + position confidence'
      : 'line baseline + inferred position confidence',
  };
};


// Match a station departure to the vehicle currently rendered on the map.
// Wiener Linien usually omits a stable vehicle number, so the fallback uses
// the freshest source station, destination, line and countdown rather than
// pretending that two same-line departures are interchangeable.

const normalise = (value) => String(value ?? '').trim().toLowerCase();

const finiteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * @param {Array<object>} vehicles vehicles returned by trainPositionEngine
 * @param {object} arrival station-panel arrival object
 * @param {string} stationName the station whose departures are being shown
 * @returns {object|null}
 */
export const findVehicleForArrival = (vehicles, arrival, stationName = '') => {
  if (!Array.isArray(vehicles) || !arrival) return null;

  const line = normalise(arrival.line);
  const destination = normalise(arrival.destination);
  const station = normalise(stationName || arrival.stationName);
  const arrivalVehicleId = normalise(arrival.vehicleId);
  const arrivalTripId = normalise(arrival.tripId);
  const arrivalSeconds = finiteNumber(arrival.seconds);

  const candidates = vehicles
    .filter((vehicle) => vehicle && (vehicle.isLive || vehicle.isScheduled))
    .filter((vehicle) => !line || normalise(vehicle.line) === line)
    .map((vehicle) => {
      const vehicleDestination = normalise(vehicle.direction || vehicle.destination);
      const sourceStation = normalise(vehicle.sourceStationName);
      const vehicleId = normalise(vehicle.vehicleId);
      const vehicleTripId = normalise(vehicle.tripId);
      const seconds = finiteNumber(vehicle.secondsToSourceStation ?? vehicle.secondsToTarget);
      let score = 0;

      if (arrivalVehicleId && vehicleId === arrivalVehicleId) score += 1000;
      if (arrivalTripId && vehicleTripId === arrivalTripId) score += 1000;
      if (destination && vehicleDestination === destination) score += 100;
      if (station && sourceStation === station) score += 180;
      if (arrivalSeconds !== null && seconds !== null) {
        score += Math.max(0, 80 - Math.abs(seconds - arrivalSeconds) / 3);
      }
      // A line/destination match is still useful for old cached arrivals that
      // predate source-station metadata, but avoid selecting a random train
      // when even the route identity disagrees.
      if (vehicleDestination && destination && vehicleDestination !== destination) score -= 160;

      return { vehicle, score };
    })
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;
  const best = candidates[0];
  const hasIdentity = arrivalVehicleId || arrivalTripId || destination || station;
  if (!hasIdentity || best.score < 45) return null;
  return best.vehicle;
};

export default findVehicleForArrival;

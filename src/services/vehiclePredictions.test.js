import { describe, expect, it } from 'vitest';
import { predictVehicleDelay, predictVehicleDwell, matchVehicleArrival } from './vehiclePredictions';

describe('per-vehicle prediction helpers', () => {
  const vehicle = {
    line: 'U1',
    direction: 'Leopoldau',
    targetStation: 'Karlsplatz',
    secondsToTarget: 90,
    isLive: true,
    status: 'Approaching',
    officialDelaySeconds: 120,
    positionConfidence: 0.7,
    positionUncertaintyMetres: 180,
    secondsUnheard: 25,
  };

  it('matches the closest official observation for the clicked train', () => {
    const arrival = matchVehicleArrival({ vehicle, arrivals: [
      { line: 'U1', stationName: 'Karlsplatz', destination: 'Leopoldau', seconds: 95, reportedDelaySeconds: 180 },
      { line: 'U1', stationName: 'Reumannplatz', destination: 'Leopoldau', seconds: 80, reportedDelaySeconds: 0 },
    ] });
    expect(arrival).toMatchObject({ stationName: 'Karlsplatz', reportedDelaySeconds: 180 });
  });

  it('returns a bounded per-train delay interval and confidence', () => {
    const prediction = predictVehicleDelay({
      vehicle,
      arrivals: [{
        line: 'U1', stationName: 'Karlsplatz', destination: 'Leopoldau', seconds: 95,
        targetTimestamp: 1_800_000_090_000, plannedTargetTimestamp: 1_800_000_000_000,
        reportedDelaySeconds: 120,
      }],
      disruptions: [],
      now: 1_800_000_000_000,
    });
    expect(prediction).toMatchObject({ station: 'Karlsplatz', predictedMinutes: 2, matchedOfficialObservation: true });
    expect(prediction.lowMinutes).toBeLessThanOrEqual(prediction.predictedMinutes);
    expect(prediction.highMinutes).toBeGreaterThanOrEqual(prediction.predictedMinutes);
    expect(prediction.confidence).toBeGreaterThan(0);
  });

  it('provides an inferred dwell forecast for en-route and platform trains', () => {
    const enRoute = predictVehicleDwell({ vehicle });
    const platform = predictVehicleDwell({ vehicle: { ...vehicle, status: 'At Platform', targetStation: 'Stephansplatz' } });
    expect(enRoute.status).toBe('dwell at next station');
    expect(platform.status).toBe('remaining platform dwell');
    expect(platform.predictedMinutes).toBeGreaterThan(enRoute.predictedMinutes);
  });
});

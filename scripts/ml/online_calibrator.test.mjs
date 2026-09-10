import { describe, expect, it } from 'vitest';
import { onlineCorrections, replayOnlineCalibration } from './online_calibrator.mjs';

const example = (eventKey, featureObservedAt, labelObservedAt, targetDelayMinutes) => ({
  eventKey,
  featureObservedAt,
  labelObservedAt,
  targetDelayMinutes,
  currentDelayMinutes: 0,
  line: 'U1',
  trafficJam: false,
  activeIncidentCount: 0,
  delayRelatedIncident: false,
});

describe('prequential online delay calibration', () => {
  it('does not learn from a label that was unavailable when a prediction was made', () => {
    const replay = replayOnlineCalibration([
      example('first', 0, 100, 12),
      example('overlapping', 50, 150, 0),
      example('later', 200, 250, 0),
    ], { minimumExamples: 3 });

    expect(replay.predictions[0]).toBe(0);
    expect(replay.predictions[1]).toBe(0);
    expect(replay.predictions[2]).toBeGreaterThan(0);
    expect(replay.status).toBe('ready');
  });

  it('keeps corrections shrunk when a line has little evidence', () => {
    const replay = replayOnlineCalibration([example('one', 0, 10, 12)]);
    const correction = onlineCorrections(replay.state, { line: 'U1' });
    expect(correction.total).toBeGreaterThan(0);
    expect(correction.total).toBeLessThan(12);
  });
});


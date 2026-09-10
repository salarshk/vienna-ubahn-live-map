import { describe, expect, it } from 'vitest';
import { compactOfficialSnapshot, summariseOfficialSnapshot } from './officialSnapshotStore';

describe('official Wiener Linien snapshots', () => {
  it('keeps official timing separate from inferred position', () => {
    const snapshot = compactOfficialSnapshot([{
      stationId: 60201320,
      stationName: 'Stephansplatz',
      arrivals: [{
        line: 'U1',
        directionCode: 'H',
        destination: 'Leopoldau',
        isLive: true,
        plannedTargetTimestamp: 1_800_000_000_000,
        targetTimestamp: 1_800_000_090_000,
        reportedDelaySeconds: 90,
        delaySource: 'wiener-linien-timeReal-minus-timePlanned',
      }, {
        line: 'U1',
        isLive: false,
        plannedTargetTimestamp: 1_800_000_120_000,
        targetTimestamp: 1_800_000_120_000,
      }],
    }], 1_800_000_000_000);

    expect(snapshot.source).toBe('wiener-linien-monitor');
    expect(snapshot.arrivals).toHaveLength(1);
    expect(snapshot.arrivals[0].officialDelaySeconds).toBe(90);
    expect(snapshot.arrivals[0].labelSource).toContain('timeReal');
  });

  it('summarises operator-reported delay by line', () => {
    const summary = summariseOfficialSnapshot({
      at: 1_800_000_000_000,
      stations: 2,
      arrivals: [
        { line: 'U1', officialDelaySeconds: 60 },
        { line: 'U1', officialDelaySeconds: 240 },
        { line: 'U2', officialDelaySeconds: 0 },
      ],
    });
    expect(summary.observations).toBe(3);
    expect(summary.meanDelaySeconds).toBe(100);
    expect(summary.delayedThreeMinutes).toBe(1);
    expect(summary.lines.find((line) => line.line === 'U1')).toMatchObject({
      observations: 2, meanDelaySeconds: 150, maxDelaySeconds: 240,
    });
  });
});

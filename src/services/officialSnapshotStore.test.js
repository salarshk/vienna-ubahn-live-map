import { describe, expect, it } from 'vitest';
import officialSnapshotStore, { compactOfficialSnapshot, summariseOfficialSnapshot } from './officialSnapshotStore';

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
    expect(snapshot.stationLineSummary).toEqual([
      expect.objectContaining({ stationName: 'Stephansplatz', line: 'U1', labelledObservations: 1, delaySumSeconds: 90 }),
    ]);
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

  it('aggregates station and line delay over rolling windows', () => {
    const now = 1_800_000_000_000;
    officialSnapshotStore.snapshots = [
      { at: now - 4 * 60 * 1000, stationLineSummary: [{ stationName: 'Stephansplatz', line: 'U1', observations: 1, labelledObservations: 1, delaySumSeconds: 60, maxDelaySeconds: 60 }] },
      { at: now - 12 * 60 * 1000, stationLineSummary: [{ stationName: 'Stephansplatz', line: 'U1', observations: 1, labelledObservations: 1, delaySumSeconds: 180, maxDelaySeconds: 180 }] },
    ];
    const windows = officialSnapshotStore.getStationLineDelayWindows('Stephansplatz', ['U1'], now);
    expect(windows.find((window) => window.id === '5m').lines[0]).toMatchObject({ labelledObservations: 1, meanDelaySeconds: 60 });
    expect(windows.find((window) => window.id === '20m').lines[0]).toMatchObject({ labelledObservations: 2, meanDelaySeconds: 120 });
    officialSnapshotStore.snapshots = [];
  });
});

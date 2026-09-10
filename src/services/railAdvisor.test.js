import { describe, expect, it } from 'vitest';
import { buildRailAdvisorEvidence } from './railAdvisor';

describe('rail advisor evidence', () => {
  it('condenses live arrivals and excludes unrelated raw fields', () => {
    const evidence = buildRailAdvisorEvidence({
      now: Date.parse('2026-09-10T12:00:00Z'),
      snapshot: { issues: [{ type: 'gap', line: 'U1', station: 'Karlsplatz', seconds: 720, private: 'omit' }] },
      arrivals: [
        { line: 'U1', isLive: true, targetTimestamp: 1_300_000, plannedTargetTimestamp: 1_000_000, destination: 'Leopoldau', vehicleId: 'secret-ish' },
        { line: 'U1', isLive: true, targetTimestamp: 1_060_000, plannedTargetTimestamp: 1_000_000, destination: 'Oberlaa' },
        { line: 'U2', isLive: false, targetTimestamp: 1_600_000, plannedTargetTimestamp: 1_000_000 },
      ],
    });

    expect(evidence.liveReportedDelayByLine).toEqual([{
      line: 'U1', livePredictions: 2, averageReportedDelayMinutes: 3,
      maximumReportedDelayMinutes: 5, delayedPredictions: 1,
      sampleDestinations: ['Leopoldau', 'Oberlaa'],
    }]);
    expect(evidence.headwayIssues[0]).not.toHaveProperty('private');
    expect(JSON.stringify(evidence)).not.toContain('vehicleId');
  });

  it('marks public-data limitations explicitly', () => {
    const evidence = buildRailAdvisorEvidence();
    expect(evidence.sourceLimitations).toHaveLength(3);
    expect(evidence.sourceLimitations.join(' ')).toContain('not vehicle GPS');
  });
});


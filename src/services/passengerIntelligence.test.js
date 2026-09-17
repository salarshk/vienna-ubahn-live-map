import { describe, expect, it } from 'vitest';
import {
  JOURNEY_STATIONS,
  buildIncidentSimilarities,
  buildRiskAwareJourneys,
  buildStationCrowdingNowcast,
  getPredictionFeedbackSummary,
} from './passengerIntelligence';

describe('passenger intelligence', () => {
  it('builds risk-ranked direct or transfer journey options', () => {
    expect(JOURNEY_STATIONS.length).toBeGreaterThan(20);
    const options = buildRiskAwareJourneys({
      origin: 'Karlsplatz',
      destination: 'Schwedenplatz',
      lineRisks: [{ line: 'U1', risk: 10 }, { line: 'U4', risk: 70 }],
    });
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].resilience).toBeGreaterThanOrEqual(options.at(-1).resilience);
  });

  it('estimates station pressure from arrivals and local headway issues', () => {
    const result = buildStationCrowdingNowcast({
      now: new Date('2026-09-17T17:30:00+02:00').getTime(),
      entries: [{ stationName: 'Karlsplatz', arrivals: [
        { line: 'U1', seconds: 80, isLive: true },
        { line: 'U2', seconds: 140, isLive: true },
        { line: 'U4', seconds: 210, isLive: true },
      ] }],
      issues: [{ type: 'bunch', station: 'Karlsplatz', line: 'U1' }],
    });
    expect(result[0]).toMatchObject({ station: 'Karlsplatz', level: expect.any(String) });
    expect(result[0].score).toBeGreaterThan(40);
  });

  it('matches current notices to archived observations', () => {
    const result = buildIncidentSimilarities({
      alerts: [{ id: 'current', title: 'Signal disruption', description: 'Delay at Karlsplatz', lines: ['U1'], station: 'Karlsplatz' }],
      history: [{ id: 'old', title: 'Signal disruption', description: 'Delay at Karlsplatz', lines: ['U1'], station: 'Karlsplatz', observedAt: Date.now() - 86400000 }],
    });
    expect(result[0].matches).toBe(1);
    expect(result[0].status).toBe('historical matches found');
  });

  it('has a safe empty feedback summary before user feedback exists', () => {
    expect(getPredictionFeedbackSummary()).toBeTypeOf('object');
  });
});


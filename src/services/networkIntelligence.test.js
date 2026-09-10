import { describe, expect, it } from 'vitest';
import { analyseHeadwayEntries, BUNCH_SECONDS, GAP_SECONDS } from './networkIntelligence';

const arrival = (line, directionCode, destination, targetTimestamp) => ({
  line, directionCode, destination, targetTimestamp, isLive: true,
});

describe('network intelligence', () => {
  it('detects prediction gaps and bunching without using marker spacing', () => {
    const now = 1_800_000_000_000;
    const entries = [{
      stationId: 1,
      stationName: 'Testplatz',
      fetchedAt: now,
      arrivals: [
        arrival('U1', 'H', 'Leopoldau', now + 60_000),
        arrival('U1', 'H', 'Leopoldau', now + (60 + BUNCH_SECONDS - 1) * 1000),
        arrival('U2', 'R', 'Seestadt', now + 60_000),
        arrival('U2', 'R', 'Seestadt', now + (60 + GAP_SECONDS + 1) * 1000),
      ],
    }];

    const issues = analyseHeadwayEntries(entries, now);
    expect(issues.find((issue) => issue.line === 'U1')?.type).toBe('bunch');
    expect(issues.find((issue) => issue.line === 'U2')?.type).toBe('gap');
  });

  it('ignores old station evidence', () => {
    const now = 1_800_000_000_000;
    const issues = analyseHeadwayEntries([{
      stationId: 1,
      stationName: 'Old stop',
      fetchedAt: now - 10 * 60_000,
      arrivals: [
        arrival('U1', 'H', 'Leopoldau', now + 60_000),
        arrival('U1', 'H', 'Leopoldau', now + 60_000 + (GAP_SECONDS + 20) * 1000),
      ],
    }], now);
    expect(issues).toEqual([]);
  });
});

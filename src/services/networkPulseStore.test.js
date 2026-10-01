import { describe, expect, it } from 'vitest';
import { compactNetworkPulseSample } from './networkPulseStore';

describe('network pulse archive samples', () => {
  it('keeps only compact service counters and classifies Vienna services', () => {
    const sample = compactNetworkPulseSample([
      { line: 'U1', isLive: true, lastDataAgeSeconds: 2 },
      { line: 'S7', isLive: false, lastDataAgeSeconds: 40 },
      { line: 'D', isLive: true, lastDataAgeSeconds: 4 },
    ], 3, 1234);

    expect(sample).toMatchObject({
      at: 1234,
      trains: 3,
      live: 2,
      fresh: 1,
      lines: 3,
      ubahn: 1,
      sbahn: 1,
      tram: 1,
      alerts: 3,
    });
    expect(sample.coordinates).toBeUndefined();
  });
});

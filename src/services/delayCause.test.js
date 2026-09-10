import { describe, expect, it } from 'vitest';
import { classifyDelayCauses } from './delayCause';

describe('delay cause classification', () => {
  it('uses official notice wording as the strongest evidence', () => {
    const [cause] = classifyDelayCauses({
      line: 'U1',
      disruptions: [{ lines: ['U1'], title: 'Signalstörung zwischen zwei Stationen' }],
    });
    expect(cause.cause).toBe('infrastructure');
    expect(cause.confidence).toBeGreaterThan(70);
    expect(cause.source).toBe('official notice');
  });
});

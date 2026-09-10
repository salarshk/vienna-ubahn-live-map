import { describe, expect, it } from 'vitest';
import { createReport, summariseReports } from './communityReports';

describe('community reports', () => {
  it('creates bounded anonymous reports and groups them by line', () => {
    const reports = [
      createReport({ line: 'U1', category: 'crowding', severity: 'high' }, 1000),
      createReport({ line: 'U1', category: 'blocked_doors' }, 1000),
      createReport({ line: 'U2', category: 'delay' }, 1000),
    ];
    const summary = summariseReports(reports, 1000);
    expect(summary.total).toBe(3);
    expect(summary.byLine.find((item) => item.line === 'U1').high).toBe(1);
    expect(summary.recent[0].source).toBe('passenger-local-report');
  });
});

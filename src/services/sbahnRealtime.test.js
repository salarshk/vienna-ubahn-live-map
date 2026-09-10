import { describe, expect, it } from 'vitest';
import { normaliseSbahnPayload } from './sbahnRealtime';

describe('S-Bahn realtime adapter', () => {
  it('normalises authorized feed records without inventing missing delay', () => {
    const [record] = normaliseSbahnPayload({ records: [{ trip_id: 't1', route_short_name: 'S45', delay: 180, cancelled: false }] }, 1000);
    expect(record.tripId).toBe('t1');
    expect(record.line).toBe('S45');
    expect(record.delaySeconds).toBe(180);
    expect(record.cancelled).toBe(false);
  });
});

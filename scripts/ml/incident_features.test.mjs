import { describe, expect, it } from 'vitest';
import {
  compactIncidentArchive,
  incidentFeaturesAt,
  normaliseLiveTrafficInfos,
} from './incident_features.mjs';

describe('U-Bahn incident features', () => {
  it('imports, filters and merges archived incident revisions', () => {
    const data = (name, line, title = 'Signalstörung') => JSON.stringify({
      name, title, priority: '2', relatedLines: [line],
      time: { start: '2026-02-01T10:00:00+0100', end: '2026-02-01T11:00:00+0100' },
    });
    const archive = compactIncidentArchive({ entities: [
      { name: 'I1', data: data('I1', 'U3'), firstSeen: '2026-02-01T10:00:00+0100', lastSeen: '2026-02-01T10:20:00+0100' },
      { name: 'I1', data: data('I1', 'U3'), firstSeen: '2026-02-01T10:21:00+0100', lastSeen: '2026-02-01T11:00:00+0100' },
      { name: 'B1', data: data('B1', '13A'), firstSeen: '2026-02-01T10:00:00+0100', lastSeen: '2026-02-01T11:00:00+0100' },
    ] });
    expect(archive.incidents).toHaveLength(1);
    expect(archive.incidents[0]).toMatchObject({ line: 'U3', priority: 2, delayRelated: true });
  });

  it('turns current traffic information into line-level features', () => {
    const now = Date.parse('2026-09-10T10:00:00Z');
    const incidents = normaliseLiveTrafficInfos({ data: { trafficInfos: [{
      name: 'I2', title: 'Verspätungen', priority: '1', relatedLines: ['U1'],
      time: { start: '2026-09-10T09:00:00Z', end: '2026-09-10T11:00:00Z' },
    }] } }, now);
    expect(incidentFeaturesAt(incidents, 'U1', now)).toEqual({
      activeIncidentCount: 1, incidentPriority: 1, delayRelatedIncident: true,
    });
    expect(incidentFeaturesAt(incidents, 'U4', now).activeIncidentCount).toBe(0);
  });
});


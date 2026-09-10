import { describe, expect, it } from 'vitest';
import { parseTrafficInfos } from './disruptionStore';

describe('Wiener Linien disruption parsing', () => {
  it('normalises affected lines, station details and whitespace', () => {
    const alerts = parseTrafficInfos({ data: { trafficInfos: [{
      name: 'tk_1',
      priority: '2',
      title: 'Station\nclosed',
      description: 'No stop at the platform',
      relatedLines: ['U3', '13A'],
      attributes: { station: 'Stephansplatz', status: 'closed' },
      time: { start: '2026-09-10T12:00:00.000+0200' },
    }] } });

    expect(alerts).toEqual([expect.objectContaining({
      id: 'tk_1', title: 'Station closed', lines: ['U3'], station: 'Stephansplatz', priority: 2,
    })]);
  });

  it('recognises elevator outages and attribute-only line arrays', () => {
    const [alert] = parseTrafficInfos({ data: { trafficInfos: [{
      refTrafficInfoCategoryId: 1,
      name: 'lift_1',
      title: 'Gumpendorfer Straße',
      attributes: { relatedLines: ['U6'], status: 'außer Betrieb' },
    }] } });
    expect(alert).toMatchObject({ lines: ['U6'], isElevator: true });
  });
});

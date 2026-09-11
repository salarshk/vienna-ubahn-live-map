import { describe, expect, it } from 'vitest';
import { parseNewsInfos, parseTrafficInfos } from './disruptionStore';

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
      categoryId: null, relatedStops: [], resolved: false,
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

  it('keeps incident lifecycle and news fields for modelling', () => {
    const [alert] = parseTrafficInfos({ data: { trafficInfos: [{
      name: 'incident-42', refTrafficInfoCategoryId: 7, owner: 'operations',
      title: 'Signal issue', relatedLines: ['U1'], relatedStops: ['60200031'],
      time: { start: '2026-09-10T12:00:00+0200', created: '2026-09-10T11:55:00+0200', lastupdate: '2026-09-10T12:05:00+0200' },
      attributes: { status: 'active' },
    }] } });
    expect(alert).toMatchObject({
      uniqueName: 'incident-42', categoryId: 7, owner: 'operations',
      relatedStops: ['60200031'], createdAt: '2026-09-10T11:55:00+0200',
    });

    const [news] = parseNewsInfos({ data: { pois: [{
      sname: 'lift-42', title: 'Lift maintenance', relatedLines: 'U6', relatedStops: '60201499',
      time: { validfrom: '2026-09-10T12:00:00+0200' },
    }] } });
    expect(news).toMatchObject({ id: 'lift-42', lines: ['U6'], relatedStops: ['60201499'] });
  });
});

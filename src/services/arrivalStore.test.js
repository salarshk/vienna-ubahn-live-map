import { describe, it, expect } from 'vitest';
import { arrivalStore, STATION_ID_MAP } from './arrivalStore';

describe('Vienna U-Bahn station identifiers', () => {
  it('resolves central interchanges to Wiener Linien DIVA ids', () => {
    expect(STATION_ID_MAP.Stephansplatz).toBe(60201320);
    expect(STATION_ID_MAP.Karlsplatz).toBe(60200657);
    expect(STATION_ID_MAP.Westbahnhof).toBe(60201468);
  });

  it('provides a live endpoint id for every tested interchange', () => {
    for (const name of ['Stephansplatz', 'Karlsplatz', 'Westbahnhof']) {
      expect(arrivalStore.getStationApiId({ name })).not.toBeNull();
    }
  });
});

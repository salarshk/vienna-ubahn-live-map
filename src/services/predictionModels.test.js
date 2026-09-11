import { describe, expect, it } from 'vitest';
import {
  calibrateUncertainty, classifyDelaySeverity, detectPredictiveAnomalies,
  predictCancellationRisk, predictDelayBands, predictDisruptionResolution, predictDwellTimes,
  predictEventDemand, predictHeadwayRisk, predictWeatherImpact,
} from './predictionModels';

describe('prediction lab models', () => {
  it('flags prolonged dwell and headway risk from observable signals', () => {
    const vehicles = [{ line: 'U1', isLive: true, status: 'At Platform', targetStation: 'Karlsplatz', secondsUnheard: 180, positionUncertaintyMetres: 300 }];
    expect(predictDwellTimes({ vehicles })[0]).toMatchObject({ line: 'U1', station: 'Karlsplatz' });
    expect(predictHeadwayRisk({ issues: [{ line: 'U1', type: 'gap', severity: 200, label: 'large gap', station: 'Karlsplatz' }], arrivals: [] })[0])
      .toMatchObject({ status: 'high', station: 'Karlsplatz', location: 'Gap near Karlsplatz' });
    const fallback = predictHeadwayRisk({ arrivals: [
      { line: 'U2', isLive: true, seconds: 60, stationName: 'Aspernstraße' },
      { line: 'U2', isLive: true, seconds: 60 + 13 * 60, stationName: 'Aspernstraße' },
    ] }).find((item) => item.line === 'U2');
    expect(fallback).toMatchObject({ station: 'Aspernstraße', location: 'Gap near Aspernstraße' });
  });

  it('classifies delay severity and exposes incident clearance evidence', () => {
    const arrivals = [{ line: 'U3', isLive: true, reportedDelaySeconds: 720 }];
    expect(classifyDelaySeverity({ arrivals, disruptions: [] }).find((item) => item.line === 'U3').category).toBe('severe');
    expect(predictDisruptionResolution({ disruptions: [{ title: 'Service disruption', lines: ['U3'] }], issues: [], reliability: [] })[0].confidence).toBeGreaterThan(0);
  });

  it('keeps unavailable external feeds explicit and remains deterministic', () => {
    expect(predictWeatherImpact({ weather: null }).status).toBe('not connected');
    expect(predictCancellationRisk({ arrivals: [], disruptions: [], issues: [] })).toHaveLength(5);
    expect(calibrateUncertainty({ vehicles: [], reliability: [] })[0].intervalMinutes).toBeGreaterThan(0);
    expect(detectPredictiveAnomalies({ vehicles: [], issues: [], arrivals: [] })).toHaveLength(5);
  });

  it('builds delay bands and extracts event demand from official text', () => {
    const bands = predictDelayBands({
      arrivals: [
        { line: 'U1', isLive: true, reportedDelaySeconds: 120 },
        { line: 'U1', isLive: true, reportedDelaySeconds: 480 },
      ],
      linePredictions: [{ line: 'U1', minutes: 4 }],
    });
    expect(bands.find((item) => item.line === 'U1')).toMatchObject({ typical: 4, samples: 2 });
    const event = predictEventDemand({
      alerts: [{ title: 'Concert at stadium', lines: ['U1'] }],
    });
    expect(event).toMatchObject({ status: 'high', confidence: 45 });
  });
});

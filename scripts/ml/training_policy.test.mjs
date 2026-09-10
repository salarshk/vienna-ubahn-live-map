import { describe, expect, it } from 'vitest';
import { trainingStageFor } from './training_policy.mjs';

const requirements = {
  preliminary: { minimumDays: 2, minimumCoverageHours: 36, minimumExamples: 150, minimumTestExamples: 30 },
  validated: { minimumDays: 7, minimumCoverageHours: 144, minimumExamples: 500, minimumTestExamples: 100 },
};

describe('delay model promotion policy', () => {
  it('waits until every preliminary safeguard is met', () => {
    expect(trainingStageFor({ dataDays: 2, coverageHours: 35, examples: 200, testExamples: 40 }, requirements)).toBe('collecting');
    expect(trainingStageFor({ dataDays: 2, coverageHours: 36, examples: 150, testExamples: 30 }, requirements)).toBe('preliminary');
  });

  it('automatically promotes a seven-day result', () => {
    expect(trainingStageFor({ dataDays: 7, coverageHours: 144, examples: 500, testExamples: 100 }, requirements)).toBe('validated');
  });
});


export const trainingStageFor = ({ dataDays, coverageHours, examples, testExamples }, requirements) => {
  const qualifies = (stage) => dataDays >= stage.minimumDays
    && coverageHours >= stage.minimumCoverageHours
    && examples >= stage.minimumExamples
    && testExamples >= stage.minimumTestExamples;
  if (qualifies(requirements.validated)) return 'validated';
  if (qualifies(requirements.preliminary)) return 'preliminary';
  return 'collecting';
};


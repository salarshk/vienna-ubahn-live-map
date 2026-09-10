const hoursSince = (timestamp, now) => Number.isFinite(Number(timestamp)) ? Math.max(0, (now - Number(timestamp)) / 3600000) : Infinity;

export const assessModelHealth = ({ model = null, metrics = null, now = Date.now() } = {}) => {
  const reasons = [];
  if (!model || !metrics) reasons.push('Model report is missing');
  if (model?.status !== 'ready') reasons.push('Model is still collecting data');
  if (model?.status === 'ready' && (!Array.isArray(model.weights) || !Array.isArray(model.scaling) || model.weights.length === 0 || model.weights.length !== model.scaling.length)) reasons.push('Model parameters are invalid');
  if (model?.deployed === false || metrics?.deployment?.deployed === false) reasons.push('Model did not beat the live baseline');
  const sampleCount = Number(metrics?.model?.sampleCount || 0);
  if (sampleCount && sampleCount < 30) reasons.push('Validation sample is small');
  const ageHours = hoursSince(model?.trainedAt || metrics?.generatedAt, now);
  if (ageHours > 36) reasons.push('Model report is stale');
  const mae = Number(metrics?.model?.maeMinutes);
  const rmse = Number(metrics?.model?.rmseMinutes);
  if (Number.isFinite(mae) && mae > 10) reasons.push('MAE exceeds 10 minutes');
  if (Number.isFinite(rmse) && rmse > 15) reasons.push('RMSE exceeds 15 minutes');
  const status = reasons.some((reason) => /missing|collecting|did not beat|stale|exceeds/.test(reason)) ? 'rollback' : reasons.length ? 'watch' : 'healthy';
  return {
    status, rollback: status === 'rollback', reasons, ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(1)) : null,
    sampleCount, maeMinutes: Number.isFinite(mae) ? mae : null, rmseMinutes: Number.isFinite(rmse) ? rmse : null,
    beatsBaseline: model?.deployed !== false && metrics?.deployment?.deployed !== false,
  };
};

export default assessModelHealth;

import { LINES } from './transitModels';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export const estimateOccupancy = ({ line, now = Date.now(), crowding = [], issues = [], vehicles = [], reports = [] } = {}) => {
  const crowd = crowding.find((item) => item.line === line);
  const lineIssues = issues.filter((item) => item.line === line);
  const lineVehicles = vehicles.filter((item) => item.line === line && item.isLive);
  const lineReports = reports.filter((item) => !item.line || item.line === line);
  const hour = new Date(now).getHours() + new Date(now).getMinutes() / 60;
  const peak = [7, 8, 9, 16, 17, 18].some((value) => Math.floor(hour) === value);
  const base = Number(crowd?.score) || 20;
  const peakBoost = peak ? 12 : 0;
  const gapBoost = lineIssues.filter((item) => item.type === 'gap').length * 5;
  const bunchBoost = lineIssues.filter((item) => item.type === 'bunch').length * 3;
  const reportBoost = lineReports.reduce((sum, item) => sum + (item.severity === 'high' ? 12 : item.severity === 'medium' ? 7 : 3), 0);
  const score = clamp(Math.round(base + peakBoost + gapBoost + bunchBoost + reportBoost), 0, 100);
  const level = score >= 75 ? 'very-high' : score >= 55 ? 'high' : score >= 30 ? 'medium' : 'low';
  const confidence = clamp(Math.round(32 + (lineVehicles.length ? 25 : 0) + (lineReports.length ? 20 : 0) + (lineIssues.length ? 15 : 0)), 20, 88);
  return {
    line, score, level, confidence, reports: lineReports.length, liveVehicles: lineVehicles.length,
    factors: [peak && 'weekday peak', lineIssues.length && `${lineIssues.length} service pattern signal${lineIssues.length > 1 ? 's' : ''}`, lineReports.length && `${lineReports.length} passenger report${lineReports.length > 1 ? 's' : ''}`].filter(Boolean),
    source: 'derived from public departures, service patterns and optional anonymous reports',
  };
};

export const estimateNetworkOccupancy = (args = {}) => LINES.map((line) => estimateOccupancy({ ...args, line }));
export default estimateNetworkOccupancy;

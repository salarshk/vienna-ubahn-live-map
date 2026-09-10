const STORAGE_KEY = 'vienna_community_reports_v1';
const EVENT_NAME = 'vienna-community-reports-updated';
const MAX_REPORTS = 200;
const REPORT_TTL_MS = 6 * 60 * 60 * 1000;

export const REPORT_CATEGORIES = [
  { id: 'crowding', label: 'Crowding' },
  { id: 'blocked_doors', label: 'Blocked doors' },
  { id: 'incident', label: 'Safety / incident' },
  { id: 'elevator', label: 'Lift / accessibility' },
  { id: 'delay', label: 'Delay not shown' },
  { id: 'other', label: 'Other' },
];

const read = () => {
  if (typeof localStorage === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const write = (reports) => {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT_NAME));
};

const clean = (reports, now = Date.now()) => reports
  .filter((report) => report && Number.isFinite(report.createdAt) && now - report.createdAt <= REPORT_TTL_MS)
  .slice(-MAX_REPORTS);

export const getReports = (now = Date.now()) => {
  const reports = clean(read(), now);
  if (reports.length !== read().length) write(reports);
  return reports;
};

export const createReport = ({ line = '', station = '', category = 'other', severity = 'medium', note = '' } = {}, now = Date.now()) => ({
  id: `report-${now}-${Math.random().toString(36).slice(2, 8)}`,
  line: String(line).slice(0, 8),
  station: String(station).trim().slice(0, 80),
  category: REPORT_CATEGORIES.some((item) => item.id === category) ? category : 'other',
  severity: ['low', 'medium', 'high'].includes(severity) ? severity : 'medium',
  note: String(note).trim().slice(0, 240),
  createdAt: now,
  expiresAt: now + REPORT_TTL_MS,
  source: 'passenger-local-report',
});

export const addReport = (input, now = Date.now()) => {
  const report = createReport(input, now);
  write(clean([...read(), report], now));
  return report;
};

export const clearReports = () => write([]);

export const summariseReports = (reports = [], now = Date.now()) => {
  const active = clean(reports, now);
  const byLine = new Map();
  active.forEach((report) => {
    const line = report.line || 'Network';
    const current = byLine.get(line) || { line, total: 0, high: 0, categories: {} };
    current.total += 1;
    if (report.severity === 'high') current.high += 1;
    current.categories[report.category] = (current.categories[report.category] || 0) + 1;
    byLine.set(line, current);
  });
  return { total: active.length, recent: active.slice(-8).reverse(), byLine: [...byLine.values()] };
};

export const subscribe = (listener) => {
  if (typeof window === 'undefined') return () => {};
  const onUpdate = () => listener(getReports());
  window.addEventListener(EVENT_NAME, onUpdate);
  return () => window.removeEventListener(EVENT_NAME, onUpdate);
};

export { REPORT_TTL_MS };
export default { getReports, addReport, createReport, clearReports, summariseReports, subscribe };

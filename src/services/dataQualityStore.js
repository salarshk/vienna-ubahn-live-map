// Published collection-health evidence for the dashboard.  This report is
// intentionally separate from the browser's local freshness score: it tells
// the user what the scheduled data pipeline actually archived and trained.

const BASE_URL = import.meta.env.BASE_URL || '/';
const REPORT_URL = `${BASE_URL}ml/data-quality.json`;

let snapshot = { status: 'loading', report: null, error: null, fetchedAt: null };
let inFlight = null;
const listeners = new Set();

const notify = () => listeners.forEach((listener) => listener(snapshot));

const loadReport = async () => {
  const response = await fetch(REPORT_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Data-quality report HTTP ${response.status}`);
  return response.json();
};

export const dataQualityStore = {
  getSnapshot: () => snapshot,
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async load({ force = false } = {}) {
    if (inFlight && !force) return inFlight;
    inFlight = loadReport()
      .then((report) => {
        snapshot = { status: report?.status || 'unknown', report, error: null, fetchedAt: Date.now() };
        notify();
        return snapshot;
      })
      .catch((error) => {
        snapshot = {
          ...snapshot,
          status: snapshot.report ? 'stale' : 'unavailable',
          error: error?.message || 'Data-quality report is unavailable.',
        };
        notify();
        return snapshot;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  },
};

export default dataQualityStore;

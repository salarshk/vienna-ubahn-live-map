// Shared network snapshot supplied by the Cloudflare Worker. The browser
// keeps its local fallback so the map remains usable when the Worker or an
// upstream feed is temporarily unavailable.

const DEFAULT_URL = 'https://vienna-rail-advisor.vienna-u-bahn-live-map.workers.dev/network-snapshot';
const API_URL = String(import.meta.env.VITE_NETWORK_API_URL || (import.meta.env.PROD ? DEFAULT_URL : '')).trim();
// Keep the shared snapshot comfortably inside the reader-facing three-second
// freshness target. The Worker edge cache uses the same two-second window;
// this leaves roughly one second for the request and render round trip.
export const NETWORK_SNAPSHOT_INTERVAL_MS = 2000;

let snapshot = { status: API_URL ? 'loading' : 'disabled', data: null, error: null, fetchedAt: null };
let inFlight = null;
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener(snapshot));

const fetchSnapshot = async () => {
  if (!API_URL) return snapshot;
  const response = await fetch(API_URL, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`Shared snapshot HTTP ${response.status}`);
  return response.json();
};

export const networkSnapshotStore = {
  getSnapshot: () => snapshot,
  isConfigured: () => Boolean(API_URL),
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async refresh({ force = false } = {}) {
    if (!API_URL) return snapshot;
    if (inFlight && !force) return inFlight;
    inFlight = fetchSnapshot().then((data) => {
      snapshot = { status: 'ready', data, error: null, fetchedAt: Date.now() };
      notify();
      return snapshot;
    }).catch((error) => {
      snapshot = { ...snapshot, status: snapshot.data ? 'stale' : 'unavailable', error: error.message };
      notify();
      return snapshot;
    }).finally(() => { inFlight = null; });
    return inFlight;
  },
};

export default networkSnapshotStore;

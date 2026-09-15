const BASE_URL = import.meta.env.BASE_URL || '/';
const REPORT_URL = `${BASE_URL}ml/operational-models.json`;

class OperationalModelStore {
  constructor() {
    this.snapshot = { status: 'loading', report: null, error: null };
    this.listeners = new Set();
    this.inFlight = null;
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  async load() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = fetch(`${REPORT_URL}?t=${Date.now()}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Operational model report is unavailable');
        const report = await response.json();
        this.snapshot = { status: 'ready', report, error: null };
        this.notify();
        return this.snapshot;
      })
      .catch((error) => {
        this.snapshot = { status: 'error', report: null, error: error.message };
        this.notify();
        return this.snapshot;
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}

export const operationalModelStore = new OperationalModelStore();
export default operationalModelStore;

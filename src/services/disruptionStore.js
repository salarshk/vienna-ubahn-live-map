import { Capacitor } from '@capacitor/core';
import { persistBrowserArchive, readBrowserArchive } from './browserArchive';

const PUBLIC_API_BASE = String(import.meta.env.VITE_VIENNA_API_BASE || '').replace(/\/$/, '');
const REFRESH_INTERVAL_MS = 120000;
const HISTORY_KEY = 'vienna_wiener_linien_incident_history_v1';
const NEWS_KEY = 'vienna_wiener_linien_news_history_v1';
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const U_BAHN_LINES = new Set(['U1', 'U2', 'U3', 'U4', 'U6']);
const LOCAL_HISTORY_CACHE_LIMIT = 500;

const buildTrafficInfoUrl = () => {
  if (Capacitor.isNativePlatform()) {
    return 'https://www.wienerlinien.at/ogd_realtime/trafficInfoList';
  }
  if (PUBLIC_API_BASE) return `${PUBLIC_API_BASE}/trafficInfoList`;
  return '/api/vienna/trafficInfoList';
};

export const buildTrafficInfoDetailsUrl = (name) => {
  const encoded = encodeURIComponent(String(name || ''));
  if (Capacitor.isNativePlatform()) return `https://www.wienerlinien.at/ogd_realtime/trafficInfo?name=${encoded}`;
  if (PUBLIC_API_BASE) return `${PUBLIC_API_BASE}/trafficInfo?name=${encoded}`;
  return `/api/vienna/trafficInfo?name=${encoded}`;
};

export const fetchTrafficInfoDetails = async (name, fetchImpl = fetch) => {
  if (!name) return null;
  const response = await fetchImpl(buildTrafficInfoDetailsUrl(name), {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const buildNewsListUrl = () => {
  if (Capacitor.isNativePlatform()) {
    return 'https://www.wienerlinien.at/ogd_realtime/newsList?name=news&name=aufzugsservice';
  }
  if (PUBLIC_API_BASE) return `${PUBLIC_API_BASE}/newsList?name=news&name=aufzugsservice`;
  return '/api/vienna/newsList?name=news&name=aufzugsservice';
};

const asArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const parseList = (value) => asArray(value)
  .flatMap((item) => String(item || '').split(','))
  .map((item) => cleanText(item))
  .filter(Boolean);

const readHistory = (key) => {
  try {
    if (typeof localStorage === 'undefined') return [];
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const writeHistory = (key, values) => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(values.slice(-LOCAL_HISTORY_CACHE_LIMIT)));
    }
  } catch {
    // A full/private browser store must not stop the live map.
  }
  void persistBrowserArchive(key, values);
};

export const parseTrafficInfos = (payload) => {
  const infos = payload?.data?.trafficInfos;
  if (!Array.isArray(infos)) return [];

  return infos.map((item, index) => {
    const attributes = item.attributes || {};
    const relatedLines = parseList(item.relatedLines?.length ? item.relatedLines : attributes.relatedLines)
      .filter((line) => U_BAHN_LINES.has(line));
    const searchable = [item.title, item.description, attributes.station, attributes.location, attributes.status]
      .map(cleanText).join(' ').toLowerCase();
    const isElevator = Number(item.refTrafficInfoCategoryId) === 1 || /aufzug|lift|elevator/.test(searchable);

    return {
      id: String(item.name || `traffic-${index}`),
      uniqueName: String(item.name || `traffic-${index}`),
      category: cleanText(item.category),
      categoryId: Number(item.refTrafficInfoCategoryId) || null,
      owner: cleanText(item.owner),
      title: cleanText(item.title) || (isElevator ? 'Elevator unavailable' : 'Service information'),
      description: cleanText(item.description),
      descriptionHTML: String(item.descriptionHTML || ''),
      lines: [...new Set(relatedLines)],
      relatedLinesDetails: item.relatedLinesDetails || null,
      relatedStops: [...new Set(parseList(item.relatedStops || attributes.relatedStops))],
      station: cleanText(attributes.station),
      location: cleanText(attributes.location),
      reason: cleanText(attributes.reason),
      status: cleanText(attributes.status),
      towards: cleanText(attributes.towards),
      priority: Number(item.priority || attributes.priority || 0),
      startsAt: item.time?.start || null,
      validFrom: item.time?.validfrom || null,
      endsAt: item.time?.end || null,
      resumeAt: item.time?.resume || null,
      createdAt: item.time?.created || null,
      lastUpdatedAt: item.time?.lastupdate || null,
      resolved: /resolved|erledigt|beendet|behoben/i.test(cleanText(attributes.status)),
      rawCategory: item.refTrafficInfoCategoryId ?? null,
      isElevator,
    };
  }).filter((item) => item.lines.length > 0 || item.station);
};

export const parseNewsInfos = (payload) => {
  const data = payload?.data || {};
  const items = data.pois || data.news || data.newsItems || data.newsList || [];
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => ({
    id: String(item.sname || item.name || `news-${index}`),
    categoryId: Number(item.refPoiCategoryId) || null,
    title: cleanText(item.title),
    subtitle: cleanText(item.subtitle),
    description: cleanText(item.description),
    lines: [...new Set(parseList(item.relatedLines))],
    relatedStops: [...new Set(parseList(item.relatedStops))],
    startsAt: item.time?.start || null,
    validFrom: item.time?.validfrom || null,
    endsAt: item.time?.end || null,
    observedAt: Date.now(),
  })).filter((item) => item.title || item.description || item.lines.length || item.relatedStops.length);
};

class DisruptionStore {
  constructor() {
    this.snapshot = {
      alerts: [], news: [], status: 'idle', lastUpdated: null, error: null,
      incidentHistorySamples: readHistory(HISTORY_KEY).length,
      newsHistorySamples: readHistory(NEWS_KEY).length,
    };
    this.listeners = new Set();
    this.inFlight = null;
    void Promise.all([readBrowserArchive(HISTORY_KEY), readBrowserArchive(NEWS_KEY)]).then(([incidentHistory, newsHistory]) => {
      const incidentCount = Array.isArray(incidentHistory) ? incidentHistory.length : this.snapshot.incidentHistorySamples;
      const newsCount = Array.isArray(newsHistory) ? newsHistory.length : this.snapshot.newsHistorySamples;
      this.snapshot = {
        ...this.snapshot,
        incidentHistorySamples: incidentCount,
        newsHistorySamples: newsCount,
      };
      this.notify();
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  getSnapshot() {
    return this.snapshot;
  }

  async refresh() {
    if (this.inFlight) return this.inFlight;
    this.snapshot = { ...this.snapshot, status: 'loading', error: null };
    this.notify();

    this.inFlight = (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      try {
        const fetchFeed = async (url) => {
          try {
            return await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
          } catch {
            return null;
          }
        };
        const [response, newsResponse] = await Promise.all([
          fetchFeed(buildTrafficInfoUrl()),
          fetchFeed(buildNewsListUrl()),
        ]);
        if (!response?.ok) throw new Error(`HTTP ${response?.status || 'network'}`);
        const payload = await response.json();
        const newsPayload = newsResponse?.ok ? await newsResponse.json() : null;
        const alerts = parseTrafficInfos(payload);
        const news = parseNewsInfos(newsPayload);
        const now = Date.now();
        const incidentHistory = [...readHistory(HISTORY_KEY), ...alerts.map((alert) => ({ observedAt: now, ...alert }))]
          .filter((item) => now - Number(item.observedAt) <= HISTORY_RETENTION_MS)
          .slice(-10000);
        const newsHistory = [...readHistory(NEWS_KEY), ...news]
          .filter((item) => now - Number(item.observedAt) <= HISTORY_RETENTION_MS)
          .slice(-10000);
        writeHistory(HISTORY_KEY, incidentHistory);
        writeHistory(NEWS_KEY, newsHistory);
        this.snapshot = {
          alerts,
          news,
          status: 'ready',
          lastUpdated: now,
          incidentHistorySamples: incidentHistory.length,
          newsHistorySamples: newsHistory.length,
          error: null,
        };
      } catch {
        this.snapshot = {
          ...this.snapshot,
          status: this.snapshot.lastUpdated ? 'ready' : 'error',
          error: 'Service information is temporarily unavailable.',
        };
      } finally {
        clearTimeout(timeoutId);
        this.inFlight = null;
        this.notify();
      }
      return this.snapshot;
    })();

    return this.inFlight;
  }
}

export { REFRESH_INTERVAL_MS };
export const disruptionStore = new DisruptionStore();
export default disruptionStore;

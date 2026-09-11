const U_BAHN_LINES = new Set(['U1', 'U2', 'U3', 'U4', 'U6']);
const DELAY_TERMS = /verspät|verkehrsbedingt|unregelmäßig|signalstörung|fahrzeugstörung|betriebsstörung|polizeieinsatz|kein betrieb|eingestellt|kurzführung/i;
const MERGE_GAP_MS = 20 * 60 * 1000;

const asArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const timestamp = (value, fallback = NaN) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

const embeddedData = (entity) => {
  if (entity?.data && typeof entity.data === 'object') return entity.data;
  if (typeof entity?.data !== 'string') return {};
  try {
    return JSON.parse(entity.data);
  } catch {
    return {};
  }
};

const relatedLines = (item) => {
  const attributes = item?.attributes || {};
  return [...new Set(asArray(item?.relatedLines?.length ? item.relatedLines : attributes.relatedLines)
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter((line) => U_BAHN_LINES.has(line)))];
};

const relatedStops = (item) => {
  const attributes = item?.attributes || {};
  return [...new Set(asArray(item?.relatedStops?.length ? item.relatedStops : attributes.relatedStops)
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean))];
};

const delayRelated = (item) => DELAY_TERMS.test([
  item?.category,
  item?.title,
  item?.description,
  item?.attributes?.reason,
].filter(Boolean).join(' '));

export const normaliseArchiveEntity = (entity) => {
  const data = embeddedData(entity);
  const lines = relatedLines(data);
  if (!lines.length) return [];
  const firstSeenMs = timestamp(entity.firstSeen, timestamp(data.time?.start));
  const lastSeenMs = timestamp(entity.lastSeen, timestamp(data.time?.end, firstSeenMs));
  if (!Number.isFinite(firstSeenMs) || !Number.isFinite(lastSeenMs)) return [];
  const id = String(data.name || entity.name || entity.RowKey || 'unknown').replace(/^bms_/, '');
  const base = {
    id,
    category: String(entity.category || data.category || ''),
    categoryId: Number(data.refTrafficInfoCategoryId ?? entity.categoryId) || null,
    title: String(data.title || entity.title || ''),
    priority: Number(data.priority ?? entity.priority ?? 0) || 0,
    status: String(data.attributes?.status || entity.status || ''),
    owner: String(data.owner || entity.owner || ''),
    relatedStops: relatedStops(data),
    createdAt: data.time?.created || null,
    lastUpdatedAt: data.time?.lastupdate || null,
    resumeAt: data.time?.resume || null,
    delayRelated: delayRelated({ ...data, category: entity.category || data.category }),
    startMs: Math.min(firstSeenMs, lastSeenMs),
    endMs: Math.max(firstSeenMs, lastSeenMs),
  };
  return lines.map((line) => ({ ...base, line }));
};

export const normaliseLiveTrafficInfos = (payload, observedAt = Date.now()) => {
  const infos = Array.isArray(payload?.data?.trafficInfos) ? payload.data.trafficInfos : [];
  return infos.flatMap((item, index) => {
    const lines = relatedLines(item);
    const id = String(item.name || `live-${index}`).replace(/^bms_/, '');
    const startMs = timestamp(item.time?.start, observedAt);
    const endMs = timestamp(item.time?.end, observedAt + 24 * 60 * 60 * 1000);
    return lines.map((line) => ({
      id,
      line,
      category: String(item.category || ''),
      categoryId: Number(item.refTrafficInfoCategoryId) || null,
      title: String(item.title || ''),
      priority: Number(item.priority ?? item.attributes?.priority ?? 0) || 0,
      status: String(item.attributes?.status || ''),
      owner: String(item.owner || ''),
      relatedStops: relatedStops(item),
      createdAt: item.time?.created || null,
      lastUpdatedAt: item.time?.lastupdate || null,
      resumeAt: item.time?.resume || null,
      delayRelated: delayRelated(item),
      startMs: Math.min(startMs, endMs),
      endMs: Math.max(startMs, endMs),
    }));
  });
};

export const compactIncidentArchive = (payload, source = {}) => {
  const entities = Array.isArray(payload?.entities) ? payload.entities : [];
  const grouped = new Map();
  entities.flatMap(normaliseArchiveEntity).forEach((incident) => {
    const key = `${incident.id}|${incident.line}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(incident);
  });

  const incidents = [];
  grouped.forEach((records) => {
    records.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    for (const record of records) {
      const previous = incidents.at(-1);
      if (previous && previous.id === record.id && previous.line === record.line
        && record.startMs <= previous.endMs + MERGE_GAP_MS) {
        previous.endMs = Math.max(previous.endMs, record.endMs);
        previous.priority = Math.max(previous.priority, record.priority);
        previous.delayRelated ||= record.delayRelated;
        if (!previous.title) previous.title = record.title;
      } else {
        incidents.push({ ...record });
      }
    }
  });
  incidents.sort((a, b) => a.startMs - b.startMs || a.line.localeCompare(b.line));

  const byLine = Object.fromEntries([...U_BAHN_LINES].map((line) => [
    line,
    incidents.filter((incident) => incident.line === line).length,
  ]));
  return {
    schemaVersion: 1,
    sourceUrl: source.url || null,
    sourceCatalogUrl: source.catalogUrl || null,
    sourceEtag: source.etag || null,
    sourceLastModified: source.lastModified || null,
    sourceExportDate: payload?.exportDate || null,
    sourceEntityCount: Number(payload?.totalEntities) || entities.length,
    importedAt: new Date().toISOString(),
    ubahnEpisodeCount: incidents.length,
    byLine,
    incidents,
  };
};

export const incidentFeaturesAt = (incidents, line, atMs) => {
  const active = (Array.isArray(incidents) ? incidents : []).filter((incident) => (
    incident.line === line && incident.startMs <= atMs && incident.endMs >= atMs
  ));
  const distinct = [...new Map(active.map((incident) => [incident.id, incident])).values()];
  return {
    activeIncidentCount: distinct.length,
    incidentPriority: distinct.reduce((highest, incident) => Math.max(highest, incident.priority || 0), 0),
    delayRelatedIncident: distinct.some((incident) => incident.delayRelated),
  };
};

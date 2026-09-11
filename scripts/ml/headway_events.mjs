export const HEADWAY_GAP_SECONDS = 7 * 60;
export const HEADWAY_BUNCH_SECONDS = 2 * 60;
export const HEADWAY_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
export const HEADWAY_RECOVERY_GRACE_MS = 2 * HEADWAY_SAMPLE_INTERVAL_MS;

const asTimestamp = (row) => {
  const parsed = Date.parse(row.realTime || '');
  if (Number.isFinite(parsed)) return parsed;
  const seconds = Number(row.secondsToReal);
  return Number.isFinite(seconds) && Number.isFinite(row.observedAt)
    ? Number(row.observedAt) + seconds * 1000
    : NaN;
};

/** Detect station-level headway anomalies from one official monitor snapshot. */
export const detectHeadwayEvents = (rows = [], observedAt = Date.now()) => {
  const groups = new Map();
  for (const row of rows) {
    const line = String(row?.line || '');
    const stationId = Number(row?.stationId);
    const timestamp = asTimestamp(row || {});
    if (!/^U[1-6]$/.test(line) || row?.realtimeSupported === false
      || !Number.isFinite(stationId) || !Number.isFinite(timestamp)) continue;
    const direction = String(row.direction || row.destination || 'unknown');
    const key = `${stationId}|${line}|${direction}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...row, timestamp });
  }

  const events = [];
  for (const entries of groups.values()) {
    const sorted = [...new Map(entries.map((row) => [
      `${row.vehicleId || row.destination}|${row.timestamp}`,
      row,
    ])).values()].sort((a, b) => a.timestamp - b.timestamp);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const next = sorted[index];
      const intervalSeconds = Math.round((next.timestamp - previous.timestamp) / 1000);
      if (intervalSeconds <= 0) continue;
      const type = intervalSeconds > HEADWAY_GAP_SECONDS
        ? 'gap'
        : intervalSeconds < HEADWAY_BUNCH_SECONDS ? 'bunch' : null;
      if (!type) continue;
      const stationName = previous.stationName || next.stationName || `Station ${previous.stationId}`;
      events.push({
        eventId: `${type}|${previous.stationId}|${previous.line}|${previous.direction || previous.destination || 'unknown'}`,
        type,
        line: previous.line,
        direction: previous.direction || previous.destination || 'unknown',
        stationId: Number(previous.stationId),
        station: stationName,
        intervalSeconds,
        severitySeconds: type === 'gap'
          ? intervalSeconds - HEADWAY_GAP_SECONDS
          : HEADWAY_BUNCH_SECONDS - intervalSeconds,
        previousVehicleId: previous.vehicleId || null,
        nextVehicleId: next.vehicleId || null,
        observedAt,
        // Preserve official coordinates if a future feed starts publishing
        // them; current public monitor responses normally do not.
        exactGpsCoordinates: previous.exactGpsCoordinates || next.exactGpsCoordinates || null,
        positionSource: previous.positionSource || next.positionSource || 'inferred-from-departure-prediction',
        exactGpsAvailable: Boolean(previous.exactGpsAvailable || next.exactGpsAvailable),
      });
    }
  }
  return events.sort((a, b) => b.severitySeconds - a.severitySeconds);
};

/**
 * Turn repeated observations into an event lifecycle. A missing event is only
 * considered recovered after two collection intervals, avoiding false recovery
 * when one upstream poll fails.
 */
export const reconcileHeadwayEvents = ({ current = [], state = {}, observedAt = Date.now() } = {}) => {
  const nextState = { ...state };
  const observations = [];
  const currentIds = new Set(current.map((event) => event.eventId));

  for (const event of current) {
    const previous = nextState[event.eventId];
    const startAt = Number.isFinite(Number(previous?.startedAt)) ? Number(previous.startedAt) : observedAt;
    const lastArchivedAt = Number(previous?.lastArchivedAt) || 0;
    const shouldArchive = !previous || observedAt - lastArchivedAt >= HEADWAY_SAMPLE_INTERVAL_MS;
    const lifecycle = {
      ...event,
      eventStatus: 'active',
      startedAt: startAt,
      lastObservedAt: observedAt,
      durationSeconds: Math.max(0, Math.round((observedAt - startAt) / 1000)),
    };
    if (shouldArchive) observations.push(lifecycle);
    nextState[event.eventId] = {
      ...event,
      startedAt: startAt,
      lastObservedAt: observedAt,
      lastArchivedAt: shouldArchive ? observedAt : lastArchivedAt,
    };
  }

  for (const [eventId, previous] of Object.entries(state)) {
    if (currentIds.has(eventId)) continue;
    const lastObservedAt = Number(previous.lastObservedAt);
    if (!Number.isFinite(lastObservedAt) || observedAt - lastObservedAt < HEADWAY_RECOVERY_GRACE_MS) continue;
    observations.push({
      ...previous,
      eventStatus: 'recovered',
      recoveredAt: observedAt,
      durationSeconds: Math.max(0, Math.round((observedAt - Number(previous.startedAt)) / 1000)),
      recoveryDurationSeconds: Math.max(0, Math.round((observedAt - Number(previous.startedAt)) / 1000)),
      positionSource: previous.positionSource || 'wiener-linien-departure-prediction',
      exactGpsAvailable: false,
    });
    delete nextState[eventId];
  }

  return { state: nextState, observations };
};

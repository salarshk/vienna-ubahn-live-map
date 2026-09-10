import sbahnData from '../data/sbahn_network.json';

const GTFS_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;

const parseGtfsDate = (value) => {
  const match = String(value || '').match(GTFS_DATE_PATTERN);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
};

const viennaDate = (instant) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
};

const calendarEnds = (sbahnData.schedule?.calendars || [])
  .map((calendar) => String(calendar.end || ''))
  .filter((value) => GTFS_DATE_PATTERN.test(value));

export const SBAHN_VALID_UNTIL = calendarEnds.sort().at(-1) || null;

export const formatGtfsDate = (value, locale = 'en-GB') => {
  const date = parseGtfsDate(value);
  return date
    ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date)
    : 'unknown';
};

export const getSbahnFreshness = (now = Date.now()) => {
  const validUntilDate = parseGtfsDate(SBAHN_VALID_UNTIL);
  if (!validUntilDate) {
    return { status: 'unknown', validUntil: null, daysRemaining: null, message: 'Timetable validity unknown' };
  }

  const instant = now instanceof Date ? now : new Date(now);
  const daysRemaining = Math.round((validUntilDate.getTime() - viennaDate(instant).getTime()) / 86400000);
  const status = daysRemaining < 0 ? 'expired' : daysRemaining <= 30 ? 'expiring' : 'fresh';
  const dateLabel = formatGtfsDate(SBAHN_VALID_UNTIL);
  const message = status === 'expired'
    ? `S-Bahn timetable expired ${dateLabel}`
    : status === 'expiring'
      ? `S-Bahn timetable expires ${dateLabel}`
      : `S-Bahn timetable valid to ${dateLabel}`;

  return { status, validUntil: SBAHN_VALID_UNTIL, daysRemaining, message };
};

export const isSbahnScheduleUsable = (now = Date.now()) => getSbahnFreshness(now).status !== 'expired';

import { badRequest } from './errors.js';

const OFFSET_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function numberAt(match: RegExpMatchArray, index: number): number {
  const value = match[index];
  if (value === undefined) {
    throw badRequest('INVALID_TIMESTAMP', 'startsAt must be a complete offset-aware timestamp.');
  }
  return Number(value);
}

export function parseOffsetDateTime(value: string): number {
  const match = value.match(OFFSET_DATE_TIME);
  if (match === null) {
    throw badRequest(
      'INVALID_TIMESTAMP',
      'startsAt must be an ISO-8601 timestamp with Z or an explicit UTC offset.',
    );
  }

  const year = numberAt(match, 1);
  const month = numberAt(match, 2);
  const day = numberAt(match, 3);
  const hour = numberAt(match, 4);
  const minute = numberAt(match, 5);
  const second = numberAt(match, 6);
  const milliseconds = Number((match[7] ?? '').padEnd(3, '0'));

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw badRequest('INVALID_TIMESTAMP', 'startsAt contains an invalid calendar date or time.');
  }

  let offsetMinutes = 0;
  if (match[8] !== 'Z') {
    const offsetHour = numberAt(match, 10);
    const offsetMinute = numberAt(match, 11);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      throw badRequest('INVALID_TIMESTAMP', 'startsAt contains an invalid UTC offset.');
    }
    const direction = match[9] === '+' ? 1 : -1;
    offsetMinutes = direction * (offsetHour * 60 + offsetMinute);
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, milliseconds);
  const timestamp = local.getTime() - offsetMinutes * 60_000;

  if (!Number.isFinite(timestamp)) {
    throw badRequest('INVALID_TIMESTAMP', 'startsAt is outside the supported date range.');
  }

  return timestamp;
}

export function toIsoString(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString();
}

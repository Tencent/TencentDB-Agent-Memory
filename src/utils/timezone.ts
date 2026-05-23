export const DEFAULT_TIMEZONE_OFFSET_MINUTES = 8 * 60;

const MIN_TIMEZONE_OFFSET_MINUTES = -14 * 60;
const MAX_TIMEZONE_OFFSET_MINUTES = 14 * 60;

export function normalizeTimezoneOffsetMinutes(
  value: number | undefined,
): number {
  if (
    value == null ||
    !Number.isInteger(value) ||
    value < MIN_TIMEZONE_OFFSET_MINUTES ||
    value > MAX_TIMEZONE_OFFSET_MINUTES
  ) {
    return DEFAULT_TIMEZONE_OFFSET_MINUTES;
  }
  return value;
}

export function formatTimezoneISO(
  date: Date,
  timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
): string {
  const offsetMinutes = normalizeTimezoneOffsetMinutes(timezoneOffsetMinutes);
  const shifted = shiftToOffset(date, offsetMinutes);
  return `${formatDatePart(shifted)}T${formatTimePart(shifted)}${formatOffset(offsetMinutes)}`;
}

export function formatTimezoneDate(
  date: Date,
  timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
): string {
  const offsetMinutes = normalizeTimezoneOffsetMinutes(timezoneOffsetMinutes);
  return formatDatePart(shiftToOffset(date, offsetMinutes));
}

function shiftToOffset(date: Date, offsetMinutes: number): Date {
  return new Date(date.getTime() + offsetMinutes * 60_000);
}

function formatDatePart(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTimePart(date: Date): string {
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${ms}`;
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

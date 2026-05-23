/**
 * Time utilities — all ISO 8601 timestamps use China Standard Time (UTC+08:00).
 */

import { DEFAULT_TIMEZONE_OFFSET_MINUTES, formatTimezoneISO } from "../utils/timezone.js";

/**
 * Get the current time as an ISO 8601 string in China Standard Time (UTC+08:00).
 * Format: "2026-03-25T16:53:51.178+08:00"
 */
export function nowChinaISO(): string {
  return toChinaISO(new Date());
}

/**
 * Convert any Date object to an ISO 8601 string in China Standard Time.
 * Format: "YYYY-MM-DDTHH:mm:ss.SSS+08:00"
 */
export function toChinaISO(date: Date): string {
  return formatTimezoneISO(date, DEFAULT_TIMEZONE_OFFSET_MINUTES);
}

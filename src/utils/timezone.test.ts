import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIMEZONE_OFFSET_MINUTES,
  formatTimezoneDate,
  formatTimezoneISO,
} from "./timezone.js";

describe("timezone formatting", () => {
  it("formats ISO timestamps with the default UTC+08:00 offset", () => {
    const value = formatTimezoneISO(
      new Date("2026-01-01T02:30:00.123Z"),
      DEFAULT_TIMEZONE_OFFSET_MINUTES,
    );

    expect(value).toBe("2026-01-01T10:30:00.123+08:00");
  });

  it("formats ISO timestamps with a negative offset", () => {
    const value = formatTimezoneISO(
      new Date("2026-01-01T02:30:00.000Z"),
      -300,
    );

    expect(value).toBe("2025-12-31T21:30:00.000-05:00");
  });

  it("formats shard dates in the configured timezone", () => {
    const value = formatTimezoneDate(
      new Date("2026-01-01T02:30:00.000Z"),
      -300,
    );

    expect(value).toBe("2025-12-31");
  });
});

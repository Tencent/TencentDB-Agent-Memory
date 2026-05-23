import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

describe("parseConfig capture timezone", () => {
  it("defaults capture timestamps to UTC+08:00", () => {
    const cfg = parseConfig({});

    expect(cfg.capture.timezoneOffsetMinutes).toBe(480);
  });

  it("accepts a custom capture timezone offset in minutes", () => {
    const cfg = parseConfig({
      capture: {
        timezoneOffsetMinutes: -300,
      },
    });

    expect(cfg.capture.timezoneOffsetMinutes).toBe(-300);
  });

  it("falls back to UTC+08:00 when the timezone offset is outside the supported range", () => {
    const cfg = parseConfig({
      capture: {
        timezoneOffsetMinutes: 15 * 60,
      },
    });

    expect(cfg.capture.timezoneOffsetMinutes).toBe(480);
  });
});

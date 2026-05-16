import { describe, expect, it } from "vitest";

import { sanitizeText } from "./storage.js";

describe("sanitizeText", () => {
  it("preserves plain ASCII", () => {
    expect(sanitizeText("hello world")).toBe("hello world");
  });

  it("preserves emoji and other non-BMP code points", () => {
    // 🎉 = U+1F389, 𠮷 = U+20BB7 (CJK Extension B), 𝐀 = U+1D400 (math bold A).
    // Each is a surrogate pair in UTF-16. Without the `u` flag, the
    // [\uD800-\uDFFF] range in UNSAFE_CHAR_RE would strip each half
    // independently and silently destroy these characters.
    expect(sanitizeText("emoji \u{1F389} here")).toBe("emoji \u{1F389} here");
    expect(sanitizeText("CJK ext-B \u{20BB7} here")).toBe(
      "CJK ext-B \u{20BB7} here",
    );
    expect(sanitizeText("math bold \u{1D400} here")).toBe(
      "math bold \u{1D400} here",
    );
  });

  it("strips lone (malformed) surrogates", () => {
    expect(sanitizeText("lone \uD800 surrogate")).toBe("lone  surrogate");
    expect(sanitizeText("lone \uDC00 surrogate")).toBe("lone  surrogate");
  });

  it("strips C0 and C1 control characters", () => {
    expect(sanitizeText("ctrlhere")).toBe("ctrlhere");
    expect(sanitizeText("c1here")).toBe("c1here");
  });

  it("strips zero-width characters and BOM", () => {
    expect(sanitizeText("a​b")).toBe("ab");
    expect(sanitizeText("a﻿b")).toBe("ab");
  });

  it("returns non-string input unchanged", () => {
    // Matches the existing typeof guard in sanitizeText.
    expect(sanitizeText(42 as unknown as string)).toBe(42);
  });
});

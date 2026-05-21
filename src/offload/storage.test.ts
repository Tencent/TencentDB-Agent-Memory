import { describe, expect, it } from "vitest";

import { sanitizeJsonLine, sanitizeText } from "./storage.js";

describe("offload storage sanitization", () => {
  it("preserves plain ASCII", () => {
    expect(sanitizeText("hello world")).toBe("hello world");
  });

  it("preserves emoji and other non-BMP code points", () => {
    expect(sanitizeText("emoji \u{1F389} here")).toBe("emoji \u{1F389} here");
    expect(sanitizeText("CJK ext-B \u{20BB7} here")).toBe(
      "CJK ext-B \u{20BB7} here",
    );
    expect(sanitizeText("math bold \u{1D400} here")).toBe(
      "math bold \u{1D400} here",
    );
    expect(sanitizeText("用户使用𠀀字和😀表情\u0000")).toBe("用户使用𠀀字和😀表情");
  });

  it("strips lone malformed surrogates", () => {
    expect(sanitizeText("lone \uD800 surrogate")).toBe("lone  surrogate");
    expect(sanitizeText("lone \uDC00 surrogate")).toBe("lone  surrogate");
  });

  it("strips C0 and C1 control characters", () => {
    expect(sanitizeText("ctrl\u0001here")).toBe("ctrlhere");
    expect(sanitizeText("c1\u0085here")).toBe("c1here");
  });

  it("strips zero-width characters and BOM", () => {
    expect(sanitizeText("a\u200Bb")).toBe("ab");
    expect(sanitizeText("a\uFEFFb")).toBe("ab");
  });

  it("preserves valid non-BMP characters in JSONL rows", () => {
    const row = JSON.stringify({
      tool_call_id: "tc_1",
      summary: "保留𠀀和😀",
    });

    const parsed = JSON.parse(sanitizeJsonLine(row)) as { summary: string };

    expect(parsed.summary).toBe("保留𠀀和😀");
  });

  it("returns non-string input unchanged", () => {
    expect(sanitizeText(42 as unknown as string)).toBe(42);
  });
});

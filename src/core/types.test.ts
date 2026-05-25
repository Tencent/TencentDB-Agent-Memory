import { describe, expect, it } from "vitest";
import { DEFAULT_HOST_CAPABILITIES } from "./types.js";

describe("DEFAULT_HOST_CAPABILITIES", () => {
  it("documents hook and transcript capabilities for planned hosts", () => {
    expect(DEFAULT_HOST_CAPABILITIES.codex).toMatchObject({
      asyncHooks: false,
      transcriptFormat: "codex-jsonl",
    });
    expect(DEFAULT_HOST_CAPABILITIES.opencode).toMatchObject({
      transcriptFormat: "opencode",
    });
    expect(DEFAULT_HOST_CAPABILITIES.openclaw).toMatchObject({
      transcriptFormat: "openclaw-messages",
    });
  });
});

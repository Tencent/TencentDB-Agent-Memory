import { describe, it, expect, vi, afterEach } from "vitest";
import { getSessionKey } from "../lib/session-key.js";

describe("getSessionKey", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("derives a 16-char hex key from cwd by default", () => {
    const key = getSessionKey("/Users/alice/projects/foo");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns the same key for the same cwd", () => {
    const k1 = getSessionKey("/Users/alice/projects/foo");
    const k2 = getSessionKey("/Users/alice/projects/foo");
    expect(k1).toBe(k2);
  });

  it("returns different keys for different cwd", () => {
    const k1 = getSessionKey("/Users/alice/projects/foo");
    const k2 = getSessionKey("/Users/alice/projects/bar");
    expect(k1).not.toBe(k2);
  });

  it("normalizes the path (foo/./bar === foo/bar)", () => {
    const k1 = getSessionKey("/Users/alice/projects/foo");
    const k2 = getSessionKey("/Users/alice/projects/./foo");
    expect(k1).toBe(k2);
  });

  it("normalizes trailing slashes", () => {
    const k1 = getSessionKey("/Users/alice/projects/foo");
    const k2 = getSessionKey("/Users/alice/projects/foo/");
    expect(k1).toBe(k2);
  });

  it("honors TDAI_SESSION_KEY env override", () => {
    vi.stubEnv("TDAI_SESSION_KEY", "custom-key-42");
    const key = getSessionKey("/whatever");
    expect(key).toBe("custom-key-42");
  });

  it("empty TDAI_SESSION_KEY falls back to cwd hash", () => {
    vi.stubEnv("TDAI_SESSION_KEY", "");
    const key = getSessionKey("/Users/alice/projects/foo");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });
});

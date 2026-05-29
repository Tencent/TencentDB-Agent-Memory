/**
 * Unit tests for memory file reader module (cos.ts).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import {
  StsCredential,
  StsCredentialManager,
  MemoryFileReader,
  cosV5Sign,
  type CosSecretResponse,
} from "../src/cos.js";
import { TDAMError } from "../src/errors.js";

// ============================
// Helpers
// ============================

function makePlatformResponse(overrides?: Partial<CosSecretResponse>): CosSecretResponse {
  return {
    CosUrl: "https://test-bucket.cos.ap-guangzhou.myqcloud.com",
    TmpSecretId: "AK_test",
    TmpSecretKey: "SK_test",
    TmpToken: "tok_test",
    ExpirationTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    PathPrefix: "pfx/",
    ...overrides,
  };
}

// ============================
// StsCredential tests
// ============================

describe("StsCredential", () => {
  it("parses fields correctly from platform response", () => {
    const cred = new StsCredential(makePlatformResponse());
    expect(cred.tmpSecretId).toBe("AK_test");
    expect(cred.bucket).toBe("test-bucket");
    expect(cred.region).toBe("ap-guangzhou");
    expect(cred.prefix).toBe("pfx/");
    expect(cred.cosHost).toBe("test-bucket.cos.ap-guangzhou.myqcloud.com");
  });

  it("adds trailing slash to prefix", () => {
    const cred = new StsCredential(makePlatformResponse({ PathPrefix: "no-slash" }));
    expect(cred.prefix).toBe("no-slash/");
  });

  it("isValid returns true for future expiry", () => {
    const cred = new StsCredential(makePlatformResponse());
    expect(cred.isValid()).toBe(true);
  });

  it("isValid returns false for past expiry", () => {
    const cred = new StsCredential(makePlatformResponse({
      ExpirationTime: "2020-01-01T00:00:00Z",
    }));
    expect(cred.isValid()).toBe(false);
  });
});

// ============================
// StsCredentialManager tests
// ============================

describe("StsCredentialManager", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as any;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  function setupManager() {
    const platformResp = makePlatformResponse();
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(platformResp),
    });
    return new StsCredentialManager({
      endpoint: "https://api.example.com",
      apiKey: "sk-test",
      serviceId: "mem-001",
    });
  }

  it("fetches on first call", async () => {
    const mgr = setupManager();
    const cred = await mgr.getCredential();
    expect(cred.tmpSecretId).toBe("AK_test");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const fetchUrl = (globalThis.fetch as any).mock.calls[0][0];
    expect(fetchUrl).toBe("https://api.example.com/v2/cos/secret");
  });

  it("caches on subsequent calls", async () => {
    const mgr = setupManager();
    await mgr.getCredential();
    await mgr.getCredential();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("refetches after invalidate", async () => {
    const mgr = setupManager();
    await mgr.getCredential();
    mgr.invalidate();
    await mgr.getCredential();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent requests", async () => {
    const mgr = setupManager();
    const [c1, c2, c3] = await Promise.all([
      mgr.getCredential(),
      mgr.getCredential(),
      mgr.getCredential(),
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(c1).toBe(c2);
    expect(c2).toBe(c3);
  });

  it("sends correct headers", async () => {
    const mgr = setupManager();
    await mgr.getCredential();
    const fetchOpts = (globalThis.fetch as any).mock.calls[0][1];
    expect(fetchOpts.headers.Authorization).toBe("Bearer sk-test");
    expect(fetchOpts.headers["x-tdai-service-id"]).toBe("mem-001");
  });
});

// ============================
// COS V5 Sign tests
// ============================

describe("cosV5Sign", () => {
  it("produces expected format", () => {
    const auth = cosV5Sign("AKID_test", "SK_test", "GET", "/test/file.md", "b.cos.r.myqcloud.com", 1000000, 1000600);
    expect(auth).toContain("q-sign-algorithm=sha1");
    expect(auth).toContain("q-ak=AKID_test");
    expect(auth).toContain("q-sign-time=1000000;1000600");
    expect(auth).toContain("q-signature=");
  });

  it("is deterministic", () => {
    const a = cosV5Sign("AK", "SK", "GET", "/a.md", "b.cos.r.myqcloud.com", 100, 200);
    const b = cosV5Sign("AK", "SK", "GET", "/a.md", "b.cos.r.myqcloud.com", 100, 200);
    expect(a).toBe(b);
  });
});

// ============================
// MemoryFileReader tests (mock fetch)
// ============================

describe("MemoryFileReader", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as any;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  function setupReader() {
    const platformResp = makePlatformResponse();
    // First call: STS credential fetch; subsequent: COS GET
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(platformResp),
    });

    const mgr = new StsCredentialManager({
      endpoint: "https://api.example.com",
      apiKey: "sk-test",
      serviceId: "mem-001",
    });
    return { reader: new MemoryFileReader(mgr), mgr };
  }

  it("reads file successfully", async () => {
    const { reader } = setupReader();
    // COS GET response
    (globalThis.fetch as any).mockResolvedValueOnce({
      status: 200,
      text: () => Promise.resolve("# Hello World"),
    });

    const content = await reader.read("scene_blocks/test.md");
    expect(content).toBe("# Hello World");

    // Second fetch call is the COS GET
    const cosUrl = (globalThis.fetch as any).mock.calls[1][0];
    expect(cosUrl).toContain("pfx/scene_blocks/test.md");
  });

  it("throws on 404", async () => {
    const { reader } = setupReader();
    (globalThis.fetch as any).mockResolvedValueOnce({
      status: 404,
      text: () => Promise.resolve("Not Found"),
    });

    await expect(reader.read("nonexist.md")).rejects.toThrow(TDAMError);
  });

  it("retries on 403 with fresh credentials", async () => {
    const { reader } = setupReader();
    // First COS GET → 403
    (globalThis.fetch as any).mockResolvedValueOnce({
      status: 403,
      text: () => Promise.resolve("Forbidden"),
    });
    // STS re-fetch after invalidate
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makePlatformResponse()),
    });
    // Retry COS GET → 200
    (globalThis.fetch as any).mockResolvedValueOnce({
      status: 200,
      text: () => Promise.resolve("retried ok"),
    });

    const content = await reader.read("test.md");
    expect(content).toBe("retried ok");
  });

  it("sends x-cos-security-token header", async () => {
    const { reader } = setupReader();
    (globalThis.fetch as any).mockResolvedValueOnce({
      status: 200,
      text: () => Promise.resolve("ok"),
    });

    await reader.read("test.md");
    // Second fetch call (index 1) is the COS GET
    const headers = (globalThis.fetch as any).mock.calls[1][1].headers;
    expect(headers["x-cos-security-token"]).toBe("tok_test");
  });
});

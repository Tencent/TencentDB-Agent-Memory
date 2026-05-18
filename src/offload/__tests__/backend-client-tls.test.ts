import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BackendClient } from "../backend-client.js";
import type { PluginLogger } from "../types.js";

function createSpyLogger(): {
  logger: PluginLogger;
  warnCalls: string[];
  infoCalls: string[];
  errorCalls: string[];
  debugCalls: string[];
} {
  const warnCalls: string[] = [];
  const infoCalls: string[] = [];
  const errorCalls: string[] = [];
  const debugCalls: string[] = [];
  const logger: PluginLogger = {
    debug: (msg: string) => debugCalls.push(msg),
    info: (msg: string) => infoCalls.push(msg),
    warn: (msg: string) => warnCalls.push(msg),
    error: (msg: string) => errorCalls.push(msg),
  };
  return { logger, warnCalls, infoCalls, errorCalls, debugCalls };
}

// Reach into the private `tlsOptions` field for assertions.
function tlsOptionsOf(client: BackendClient): { rejectUnauthorized?: boolean; ca?: Buffer } {
  return (client as unknown as { tlsOptions: { rejectUnauthorized?: boolean; ca?: Buffer } })
    .tlsOptions;
}

describe("BackendClient TLS options", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-tls-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults to secure TLS (no opts injected) when neither env var is set", () => {
    const { logger, warnCalls, infoCalls } = createSpyLogger();
    const client = new BackendClient("https://backend.example.com", logger, "test-key");
    const opts = tlsOptionsOf(client);

    // No overrides means we let node:https default to its system-trust-store
    // behaviour (rejectUnauthorized: true). We explicitly do NOT set the field
    // — that way a caller that *also* wanted to override gets the most natural
    // composition.
    expect(opts.rejectUnauthorized).toBeUndefined();
    expect(opts.ca).toBeUndefined();
    expect(warnCalls).toHaveLength(0);
    // No info either — silent secure default.
    expect(infoCalls.filter((m) => m.includes("CA"))).toHaveLength(0);
  });

  it("disables verification when TDAI_OFFLOAD_INSECURE_TLS=1 and emits a loud warning", () => {
    vi.stubEnv("TDAI_OFFLOAD_INSECURE_TLS", "1");
    const { logger, warnCalls } = createSpyLogger();
    const client = new BackendClient("https://backend.example.com", logger, "test-key");
    const opts = tlsOptionsOf(client);

    expect(opts.rejectUnauthorized).toBe(false);
    expect(opts.ca).toBeUndefined();
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatch(/TDAI_OFFLOAD_INSECURE_TLS=1/);
    expect(warnCalls[0]).toMatch(/DISABLED/);
    // Steer the operator toward the safer alternative.
    expect(warnCalls[0]).toMatch(/TDAI_OFFLOAD_CA_PEM_PATH/);
  });

  it("ignores TDAI_OFFLOAD_INSECURE_TLS values other than the literal '1'", () => {
    for (const v of ["true", "yes", "0", "", "1 "]) {
      vi.stubEnv("TDAI_OFFLOAD_INSECURE_TLS", v);
      const { logger, warnCalls } = createSpyLogger();
      const client = new BackendClient("https://backend.example.com", logger, "test-key");
      const opts = tlsOptionsOf(client);
      expect(opts.rejectUnauthorized, `value=${JSON.stringify(v)}`).toBeUndefined();
      expect(warnCalls, `value=${JSON.stringify(v)}`).toHaveLength(0);
    }
  });

  it("loads CA bytes when TDAI_OFFLOAD_CA_PEM_PATH points at a readable file", () => {
    const caPath = path.join(tmpDir, "ca.pem");
    const caBytes = Buffer.from(
      "-----BEGIN CERTIFICATE-----\nFAKE_PEM_BYTES_FOR_TEST\n-----END CERTIFICATE-----\n",
    );
    fs.writeFileSync(caPath, caBytes);
    vi.stubEnv("TDAI_OFFLOAD_CA_PEM_PATH", caPath);

    const { logger, warnCalls, infoCalls } = createSpyLogger();
    const client = new BackendClient("https://backend.example.com", logger, "test-key");
    const opts = tlsOptionsOf(client);

    expect(opts.ca?.equals(caBytes)).toBe(true);
    expect(opts.rejectUnauthorized).toBeUndefined(); // CA load alone does NOT disable verification
    expect(warnCalls).toHaveLength(0);
    expect(infoCalls.some((m) => m.includes(caPath))).toBe(true);
  });

  it("warns but does not throw when TDAI_OFFLOAD_CA_PEM_PATH points at a missing file", () => {
    const caPath = path.join(tmpDir, "does-not-exist.pem");
    vi.stubEnv("TDAI_OFFLOAD_CA_PEM_PATH", caPath);

    const { logger, warnCalls } = createSpyLogger();
    // Construction must not throw — a misconfigured CA path should degrade
    // gracefully to "use system trust store" rather than break the daemon.
    expect(() => new BackendClient("https://backend.example.com", logger, "test-key")).not.toThrow();
    const client = new BackendClient("https://backend.example.com", logger, "test-key");
    const opts = tlsOptionsOf(client);

    expect(opts.ca).toBeUndefined();
    expect(warnCalls.some((m) => m.includes(caPath))).toBe(true);
    expect(warnCalls.some((m) => m.includes("Falling back to system trust store"))).toBe(true);
  });

  it("combines INSECURE_TLS=1 and CA_PEM_PATH (insecure wins; CA still loaded for completeness)", () => {
    const caPath = path.join(tmpDir, "ca.pem");
    const caBytes = Buffer.from("PEM");
    fs.writeFileSync(caPath, caBytes);
    vi.stubEnv("TDAI_OFFLOAD_INSECURE_TLS", "1");
    vi.stubEnv("TDAI_OFFLOAD_CA_PEM_PATH", caPath);

    const { logger, warnCalls, infoCalls } = createSpyLogger();
    const client = new BackendClient("https://backend.example.com", logger, "test-key");
    const opts = tlsOptionsOf(client);

    expect(opts.rejectUnauthorized).toBe(false);
    expect(opts.ca?.equals(caBytes)).toBe(true);
    // Both signals surface to the operator.
    expect(warnCalls.some((m) => m.includes("TDAI_OFFLOAD_INSECURE_TLS"))).toBe(true);
    expect(infoCalls.some((m) => m.includes(caPath))).toBe(true);
  });

  it("resolves TLS options once at construction (no per-request env re-read)", () => {
    // No env set at construction time.
    const { logger } = createSpyLogger();
    const client = new BackendClient("https://backend.example.com", logger, "test-key");
    expect(tlsOptionsOf(client).rejectUnauthorized).toBeUndefined();

    // Later changes to env must NOT retroactively affect the existing instance.
    // (Construction-time resolution gives a stable, auditable security posture
    // for the lifetime of the daemon.)
    vi.stubEnv("TDAI_OFFLOAD_INSECURE_TLS", "1");
    expect(tlsOptionsOf(client).rejectUnauthorized).toBeUndefined();
  });
});

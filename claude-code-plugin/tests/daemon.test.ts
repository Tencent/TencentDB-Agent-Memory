import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonManager,
  readDaemonState,
  writeDaemonState,
} from "../lib/daemon.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "tdai-daemon-test-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("DaemonManager state file", () => {
  it("readDaemonState returns null when state.json missing", async () => {
    const state = await readDaemonState(dataDir);
    expect(state).toBeNull();
  });

  it("writeDaemonState writes a parseable JSON file", async () => {
    await writeDaemonState(dataDir, {
      pid: 999,
      port: 8421,
      ccPid: 998,
      startedAt: "2026-05-15T10:00:00Z",
      tokenPath: join(dataDir, "token"),
    });
    const state = await readDaemonState(dataDir);
    expect(state).toEqual({
      pid: 999,
      port: 8421,
      ccPid: 998,
      startedAt: "2026-05-15T10:00:00Z",
      tokenPath: join(dataDir, "token"),
    });
  });
});

describe("DaemonManager token file", () => {
  it("generateToken creates a 600-mode file with 256-bit base64url token", async () => {
    const mgr = new DaemonManager({ dataDir });
    const tokenPath = await mgr.generateToken();
    const content = await readFile(tokenPath, "utf-8");
    expect(content).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const st = await stat(tokenPath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("readToken throws when permission is too loose", async () => {
    const tokenPath = join(dataDir, "token");
    await writeFile(tokenPath, "abc", { mode: 0o644 });
    const mgr = new DaemonManager({ dataDir });
    await expect(mgr.readToken(tokenPath)).rejects.toThrow(/permission/i);
  });

  it("readToken returns the trimmed token when permission is 600", async () => {
    const tokenPath = join(dataDir, "token");
    await writeFile(tokenPath, "secret-token\n", { mode: 0o600 });
    const mgr = new DaemonManager({ dataDir });
    const tok = await mgr.readToken(tokenPath);
    expect(tok).toBe("secret-token");
  });
});

describe("DaemonManager findFreePort", () => {
  it("returns a free port within range", async () => {
    const mgr = new DaemonManager({ dataDir });
    const port = await mgr.findFreePort(18500, 18510);
    expect(port).toBeGreaterThanOrEqual(18500);
    expect(port).toBeLessThanOrEqual(18510);
  });

  it("throws when all ports are taken", async () => {
    const http = await import("node:http");
    const blockers: import("node:http").Server[] = [];
    for (let p = 18600; p <= 18602; p++) {
      const s = http.createServer();
      await new Promise<void>((r) => s.listen(p, "127.0.0.1", () => r()));
      blockers.push(s);
    }
    try {
      const mgr = new DaemonManager({ dataDir });
      await expect(mgr.findFreePort(18600, 18602)).rejects.toThrow(/no free port/i);
    } finally {
      for (const s of blockers) await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

describe("DaemonManager probe", () => {
  it("probe returns false when state.json is missing", async () => {
    const mgr = new DaemonManager({ dataDir });
    expect(await mgr.probe()).toBe(false);
  });

  it("probe returns false when daemon health check fails", async () => {
    await writeDaemonState(dataDir, {
      pid: 99999,
      port: 1,
      ccPid: process.pid,
      startedAt: "2026-05-15T10:00:00Z",
      tokenPath: join(dataDir, "token"),
    });
    await writeFile(join(dataDir, "token"), "x", { mode: 0o600 });
    const mgr = new DaemonManager({ dataDir });
    expect(await mgr.probe()).toBe(false);
  });
});

describe("DaemonManager ensureRunning ccPid mismatch", () => {
  // Confirms reuseExisting refuses a state.json whose ccPid differs from the
  // caller's ccPid — guards against picking up a daemon spawned by a different
  // cc instance on a shared box.
  it("does NOT reuse a daemon recorded for a foreign ccPid", async () => {
    const tokenPath = join(dataDir, "token");
    await writeFile(tokenPath, "secret-foreign", { mode: 0o600 });
    await writeDaemonState(dataDir, {
      pid: 12345,
      port: 18999, // nothing actually listening here
      ccPid: 999_999, // some other cc
      startedAt: "2026-05-15T10:00:00Z",
      tokenPath,
    });

    const mgr = new DaemonManager({ dataDir, portStart: 18500, portEnd: 18510 });
    // Stub spawn to a thin marker so we don't actually fork a daemon.
    let spawnCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any).spawn = async () => {
      spawnCalls++;
      return {
        pid: 1,
        port: 18500,
        ccPid: process.pid,
        startedAt: new Date().toISOString(),
        tokenPath,
      };
    };
    await mgr.ensureRunning(process.pid);
    expect(spawnCalls).toBe(1);
  });
});

/**
 * Daemon manager — spawns the TdaiGateway as a long-lived sidecar bound
 * to the parent cc process. Mirrors the supervisor.py pattern from
 * hermes-plugin/.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";

export interface DaemonState {
  pid: number;
  port: number;
  ccPid: number;
  startedAt: string;
  tokenPath: string;
}

export interface DaemonManagerConfig {
  dataDir: string;
  portStart?: number;
  portEnd?: number;
}

const DEFAULT_PORT_START = 8421;
const DEFAULT_PORT_END = 8430;
const STATE_FILE = "state.json";

export async function readDaemonState(dataDir: string): Promise<DaemonState | null> {
  const path = join(dataDir, STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as DaemonState;
  } catch {
    return null;
  }
}

export async function writeDaemonState(dataDir: string, state: DaemonState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, STATE_FILE), JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

export async function clearDaemonState(dataDir: string): Promise<void> {
  const path = join(dataDir, STATE_FILE);
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

export class DaemonManager {
  private dataDir: string;
  private portStart: number;
  private portEnd: number;

  constructor(config: DaemonManagerConfig) {
    this.dataDir = config.dataDir;
    this.portStart = config.portStart ?? DEFAULT_PORT_START;
    this.portEnd = config.portEnd ?? DEFAULT_PORT_END;
  }

  async generateToken(): Promise<string> {
    await mkdir(this.dataDir, { recursive: true });
    const token = randomBytes(32).toString("base64url");
    const tokenPath = join(this.dataDir, "token");
    await writeFile(tokenPath, token, { mode: 0o600 });
    return tokenPath;
  }

  async readToken(tokenPath: string): Promise<string> {
    const st = await stat(tokenPath);
    // Windows' Node fs reports mode bits that don't map to POSIX rwx, so
    // the 0o077 check would always fire and block Windows users entirely.
    // Skip the bit-level check there and rely on the NTFS ACL the OS gave
    // the file at create time.
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      throw new Error(`Token file permission too loose: ${tokenPath}`);
    }
    // Owner check: refuse to read a token file we don't own. Guards the
    // multi-user case where ~/.tdai-memory is on a shared FS and a peer
    // UID could pre-create the file to phish the daemon.
    if (process.platform !== "win32" && typeof process.getuid === "function") {
      const uid = process.getuid();
      if (st.uid !== uid) {
        throw new Error(
          `Token file owner mismatch: expected uid=${uid}, got uid=${st.uid} for ${tokenPath}`,
        );
      }
    }
    const raw = await readFile(tokenPath, "utf-8");
    return raw.trim();
  }

  async findFreePort(
    start = this.portStart,
    end = this.portEnd,
  ): Promise<number> {
    for (let p = start; p <= end; p++) {
      if (await this.isPortFree(p)) return p;
    }
    throw new Error(`No free port in ${start}..${end}`);
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(false));
      tester.once("listening", () => {
        tester.close(() => resolve(true));
      });
      tester.listen(port, "127.0.0.1");
    });
  }

  async probe(): Promise<boolean> {
    const state = await readDaemonState(this.dataDir);
    if (!state) return false;
    let token: string;
    try {
      token = await this.readToken(state.tokenPath);
    } catch {
      return false;
    }
    return this.healthCheck(state.port, token);
  }

  private healthCheck(port: number, token: string, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/health",
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => resolve(res.statusCode === 200),
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    });
  }

  async ensureRunning(ccPid: number): Promise<DaemonState> {
    const existing = await readDaemonState(this.dataDir);
    if (existing) {
      // Refuse to reuse a daemon spawned for a different cc instance. Without
      // this check, a stale state.json from a previous user/session on a shared
      // box could route this session's recall/capture to someone else's daemon.
      const ccPidMatches = existing.ccPid === ccPid;
      let existingToken = "";
      try {
        existingToken = await this.readToken(existing.tokenPath);
      } catch {
        // fallthrough to spawn
      }
      if (ccPidMatches && existingToken) {
        // First probe.
        if (await this.healthCheck(existing.port, existingToken)) return existing;
        // Daemon may still be coming up (another hook just spawned it).
        // Wait briefly and retry once before deciding to respawn.
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          await sleep(500);
          if (await this.healthCheck(existing.port, existingToken)) return existing;
        }
      }
    }
    return this.spawn(ccPid);
  }

  /**
   * Spawn the Gateway daemon by invoking `npx tdai-memory-gateway`.
   *
   * The user must have `@tencentdb-agent-memory/memory-tencentdb` installed,
   * either globally (`npm install -g`) or in the current project (which exposes
   * the `tdai-memory-gateway` bin via npx's PATH resolution).
   */
  async spawn(ccPid: number): Promise<DaemonState> {
    const port = await this.findFreePort();
    const tokenPath = await this.generateToken();
    const token = await this.readToken(tokenPath);

    const command = process.env.TDAI_GATEWAY_COMMAND ?? "npx";
    const args = process.env.TDAI_GATEWAY_COMMAND
      ? []
      : ["--yes", "tdai-memory-gateway"];

    // Pass the token by FILE PATH, not as an env var. execve() snapshots the
    // initial environment block and exposes it via /proc/<pid>/environ /
    // `ps -E` to any peer process with the same UID — a token file gated by
    // 0600 + owner check is a smaller attack surface.
    const childEnv = { ...process.env, TDAI_GATEWAY_PORT: String(port), TDAI_CC_PID: String(ccPid), TDAI_TOKEN_PATH: tokenPath } as NodeJS.ProcessEnv;
    delete childEnv.TDAI_GATEWAY_TOKEN;

    const child: ChildProcess = spawn(command, args, {
      env: childEnv,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();

    if (!child.pid) {
      throw new Error("Failed to spawn daemon: child has no pid");
    }

    // Write state.json IMMEDIATELY so concurrent hooks (e.g. Stop firing
    // before SessionStart's spawn finishes its health probe) see that a
    // daemon is being brought up and can wait for it via ensureRunning's
    // health-retry loop, instead of treating it as "no daemon".
    const pendingState: DaemonState = {
      pid: child.pid,
      port,
      ccPid,
      startedAt: new Date().toISOString(),
      tokenPath,
    };
    await writeDaemonState(this.dataDir, pendingState);

    // Gateway cold-start needs to init SQLite + sqlite-vec + BM25 encoder +
    // pipeline + LLM runner. On slower machines this can exceed 10s, so give
    // it 30s. The hook is async (cc doesn't block on it) so the longer
    // budget doesn't impact UX.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.healthCheck(port, token, 500)) {
        return pendingState;
      }
      await sleep(200);
    }

    // Health probe timed out. Remove the pending state so subsequent hooks
    // don't keep waiting on a daemon that never came up.
    await clearDaemonState(this.dataDir);
    throw new Error(`Daemon did not become healthy on port ${port} within 30s`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

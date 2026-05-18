/**
 * Daemon manager — spawns the TdaiGateway as a long-lived sidecar bound
 * to the parent cc process. Mirrors the supervisor.py pattern from
 * hermes-plugin/.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, stat, unlink, open, rename } from "node:fs/promises";
import { existsSync, openSync } from "node:fs";
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
  // Atomic write: a concurrent reader never observes a half-written JSON.
  const tmp = join(dataDir, `${STATE_FILE}.tmp`);
  const final = join(dataDir, STATE_FILE);
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, final);
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
    const reuseExisting = async (): Promise<DaemonState | null> => {
      const existing = await readDaemonState(this.dataDir);
      if (!existing) return null;
      if (existing.ccPid !== ccPid) return null;
      let token = "";
      try {
        token = await this.readToken(existing.tokenPath);
      } catch {
        return null;
      }
      if (!token) return null;
      if (await this.healthCheck(existing.port, token)) return existing;
      // Daemon may still be coming up (another hook just spawned it).
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await sleep(500);
        if (await this.healthCheck(existing.port, token)) return existing;
      }
      return null;
    };

    const reused = await reuseExisting();
    if (reused) return reused;

    // O_CREAT|O_EXCL spawn lock — only one concurrent hook actually invokes
    // spawn(). Other hooks block on it and recover the spawned state.
    const lock = await this.acquireSpawnLock();
    if (!lock) {
      // Lock held by a peer hook. Wait up to 35s for it to write state.json
      // and bring the daemon up.
      const deadline = Date.now() + 35_000;
      while (Date.now() < deadline) {
        await sleep(500);
        const r = await reuseExisting();
        if (r) return r;
      }
      throw new Error("daemon spawn lock contention timed out");
    }
    try {
      // Re-check inside the lock — a peer might have finished between our
      // first reuseExisting and acquireSpawnLock.
      const r = await reuseExisting();
      if (r) return r;
      return await this.spawn(ccPid);
    } finally {
      await lock.release();
    }
  }

  /**
   * Returns a held lock handle, or null if another process owns the lock.
   * Stale locks (>60s old) are forcibly broken so a crashed hook never wedges
   * the daemon-up path.
   */
  private async acquireSpawnLock(): Promise<{ release(): Promise<void> } | null> {
    await mkdir(this.dataDir, { recursive: true });
    const lockPath = join(this.dataDir, "spawn.lock");
    const tryCreate = async (): Promise<{ release(): Promise<void> } | null> => {
      try {
        const fh = await open(lockPath, "wx"); // O_CREAT|O_EXCL|O_WRONLY
        await fh.write(`${process.pid}\n`);
        await fh.close();
        return {
          release: async () => {
            try {
              await unlink(lockPath);
            } catch {
              // already gone
            }
          },
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
        throw err;
      }
    };
    const first = await tryCreate();
    if (first) return first;
    try {
      const st = await stat(lockPath);
      if (Date.now() - st.mtimeMs > 60_000) {
        await unlink(lockPath).catch(() => {});
        return tryCreate();
      }
    } catch {
      // race: lock disappeared, retry once
      return tryCreate();
    }
    return null;
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
    //
    // Also pin TDAI_DATA_DIR explicitly: without it the gateway resolves its
    // data dir against process.cwd() of the spawning hook, which can be any
    // arbitrary user directory and would split data across cwds.
    const childEnv = {
      ...process.env,
      TDAI_GATEWAY_PORT: String(port),
      TDAI_CC_PID: String(ccPid),
      TDAI_TOKEN_PATH: tokenPath,
      TDAI_DATA_DIR: process.env.TDAI_DATA_DIR ?? this.dataDir,
    } as NodeJS.ProcessEnv;
    delete childEnv.TDAI_GATEWAY_TOKEN;

    // Redirect stderr (and stdout) into daemon.log so cold-start crashes are
    // not swallowed silently. detached + unref keeps the daemon alive past
    // the hook process exit; the log fds are independent of our stdio.
    await mkdir(this.dataDir, { recursive: true });
    const logPath = join(this.dataDir, "daemon.log");
    let logFd: number | "ignore" = "ignore";
    try {
      logFd = openSync(logPath, "a");
    } catch {
      // fall back to discarding stderr if we can't open the log
    }

    const child: ChildProcess = spawn(command, args, {
      env: childEnv,
      cwd: this.dataDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
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

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
    if ((st.mode & 0o077) !== 0) {
      throw new Error(`Token file permission too loose: ${tokenPath}`);
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
      let existingToken = "";
      try {
        existingToken = await this.readToken(existing.tokenPath);
      } catch {
        // fallthrough to spawn
      }
      if (existingToken && (await this.healthCheck(existing.port, existingToken))) {
        return existing;
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

    const child: ChildProcess = spawn(command, args, {
      env: {
        ...process.env,
        TDAI_GATEWAY_TOKEN: token,
        TDAI_GATEWAY_PORT: String(port),
        TDAI_CC_PID: String(ccPid),
      },
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();

    if (!child.pid) {
      throw new Error("Failed to spawn daemon: child has no pid");
    }

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await this.healthCheck(port, token, 500)) {
        const state: DaemonState = {
          pid: child.pid,
          port,
          ccPid,
          startedAt: new Date().toISOString(),
          tokenPath,
        };
        await writeDaemonState(this.dataDir, state);
        return state;
      }
      await sleep(200);
    }

    throw new Error(`Daemon did not become healthy on port ${port} within 10s`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

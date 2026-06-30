#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTANCES_FILE = join(ROOT, ".animarouter.instances");
const LOG_FILE = join(ROOT, "server.log");

// Log rotation: cap the active log at 50 MiB; keep at most 3 archived copies.
// Worst-case footprint is therefore ~150 MiB. Rotation happens between
// sessions (i.e. on `api start`, before opening the write fd) so we never
// rename a file that the running server is still appending to.
const LOG_MAX_BYTES = 50 * 1024 * 1024;
const LOG_ARCHIVES = 3;
const LOG_ARCHIVE_FMT = (i) => join(ROOT, `server.log.${i}`);

function rotateLogIfNeeded() {
  // One-shot rescue: if any prior archive is far above the cap, drop it
  // outright. This handles the legacy 11 GB server.log case after this
  // rotation policy was added; once everything is at ≤ LOG_MAX_BYTES, this
  // path is dead code.
  for (const path of [
    LOG_FILE,
    ...Array.from({ length: LOG_ARCHIVES }, (_, i) => LOG_ARCHIVE_FMT(i + 1)),
  ]) {
    let size;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    if (size > 4 * LOG_MAX_BYTES) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }

  let size;
  try {
    size = statSync(LOG_FILE).size;
  } catch {
    return;
  }
  if (size < LOG_MAX_BYTES) return;
  // Drop the oldest archive, shift the rest down, then move active → .1.
  try {
    unlinkSync(LOG_ARCHIVE_FMT(LOG_ARCHIVES));
  } catch {}
  for (let i = LOG_ARCHIVES - 1; i >= 1; i--) {
    try {
      renameSync(LOG_ARCHIVE_FMT(i), LOG_ARCHIVE_FMT(i + 1));
    } catch {}
  }
  try {
    renameSync(LOG_FILE, LOG_ARCHIVE_FMT(1));
  } catch {}
}

function usage() {
  console.log(`
AnimaRouter CLI

  api start [--port <number>]   Start the server (uses .env PORT by default)
  api stop [--port <number>]    Stop a specific instance, or the only one
  api stop --all                Stop all running instances
  api restart                   Stop then start (uses .env PORT)
  api status                    Show running instances
  api list                      List all instances across ports
  api build                     Build the project
  api logs                      Tail the server log
  api help                      Show this help

After start, the server runs in the background. Access the dashboard
at http://localhost:3001 and the API at http://localhost:3001/v1.
`);
}

function readInstances() {
  try {
    return JSON.parse(readFileSync(INSTANCES_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeInstances(inst) {
  writeFileSync(INSTANCES_FILE, JSON.stringify(inst, null, 2));
}

function readPort() {
  try {
    const env = readFileSync(join(ROOT, ".env"), "utf8");
    const m = env.match(/^PORT=(\d+)/m);
    return m ? parseInt(m[1], 10) : 3001;
  } catch {
    return 3001;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanInstances() {
  const inst = readInstances();
  let changed = false;
  for (const [port, pid] of Object.entries(inst)) {
    if (!isRunning(pid)) {
      delete inst[port];
      changed = true;
    }
  }
  if (changed) {
    if (Object.keys(inst).length === 0) {
      try {
        unlinkSync(INSTANCES_FILE);
      } catch {}
    } else {
      writeInstances(inst);
    }
  }
  return inst;
}

function build() {
  return new Promise((resolve, reject) => {
    console.log("Building AnimaRouter…");
    const child = spawn("npm", ["run", "build"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Build failed with code ${code}`));
    });
  });
}

function needsBuild() {
  if (!existsSync(join(ROOT, "server", "dist", "index.js"))) return true;
  if (!existsSync(join(ROOT, "client", "dist", "index.html"))) return true;
  return false;
}

async function ensureBuilt() {
  if (needsBuild()) await build();
}

function startServer(port) {
  const inst = cleanInstances();

  if (inst[String(port)]) {
    const pid = inst[String(port)];
    if (isRunning(pid)) {
      console.log(`Server is already running on port ${port} (PID ${pid}).`);
      printInfo(port);
      return;
    }
  }

  rotateLogIfNeeded();

  let out;
  try {
    out = openSync(LOG_FILE, "a");
  } catch {
    out = "ignore";
  }

  const child = spawn("node", ["server/dist/index.js"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, PORT: String(port) },
  });

  let crashed = false;
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      crashed = true;
      const i = readInstances();
      delete i[String(port)];
      if (Object.keys(i).length === 0) {
        try {
          unlinkSync(INSTANCES_FILE);
        } catch {}
      } else {
        writeInstances(i);
      }
      console.error(
        `Server on port ${port} exited with code ${code}. Check server.log.`,
      );
    }
  });

  child.on("error", (err) => {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  });

  child.unref();

  inst[String(port)] = child.pid;
  writeInstances(inst);

  console.log(`Starting server on port ${port} (PID ${child.pid})…`);
  return waitForReady(port, child)
    .then(() => {
      console.log("Server is ready.\n");
      printInfo(port);
    })
    .catch((err) => {
      if (crashed) return;
      console.error(err.message);
      process.exit(1);
    });
}

function waitForReady(port, child) {
  const start = Date.now();
  const timeout = 30000;
  const stderrChunks = [];
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const once = (fn) => (v) => {
      if (!settled) {
        settled = true;
        fn(v);
      }
    };

    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        const stderrMsg = Buffer.concat(stderrChunks).toString().trim();
        const msg = stderrMsg
          ? `Server exited with code ${code}: ${stderrMsg}`
          : `Server exited with code ${code} before becoming ready`;
        once(reject)(new Error(msg));
      } else if (code === 0) {
        once(reject)(
          new Error(
            "Server exited unexpectedly with code 0 before becoming ready",
          ),
        );
      }
    });

    const check = () => {
      const req = http.get(`http://localhost:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) once(resolve)();
        else retry();
      });
      req.on("error", () => retry());
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
      function retry() {
        if (Date.now() - start > timeout) {
          once(reject)(
            new Error(
              "Health check timed out after 30s. Server may have failed to start.",
            ),
          );
        } else {
          setTimeout(check, 500);
        }
      }
    };
    check();
  });
}

function printInfo(port) {
  console.log(`  Dashboard   http://localhost:${port}`);
  console.log(`  API base    http://localhost:${port}/v1`);
  console.log(
    `  OpenAI SDK  client = OpenAI({ base_url: "http://localhost:${port}/v1", api_key: "…" })`,
  );
  console.log("");
  if (Object.keys(readInstances()).length > 1) {
    console.log(`  Stop:        api stop --port ${port}`);
    console.log(`  Stop all:    api stop --all`);
  } else {
    console.log(`  Stop:        api stop`);
  }
  console.log(`  Status:      api status`);
  console.log(`  Logs:        api logs`);
}

function stopOne(port) {
  const inst = readInstances();
  const key = String(port);
  const pid = inst[key];
  if (!pid) {
    console.log(`No server running on port ${port}.`);
    return Promise.resolve();
  }
  if (!isRunning(pid)) {
    console.log(`PID ${pid} on port ${port} is not running. Cleaning up.`);
    delete inst[key];
    if (Object.keys(inst).length === 0) {
      try {
        unlinkSync(INSTANCES_FILE);
      } catch {}
    } else {
      writeInstances(inst);
    }
    return Promise.resolve();
  }
  console.log(`Stopping server on port ${port} (PID ${pid})…`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    console.log(`Failed: ${e.message}`);
  }
  return new Promise((resolve) => {
    let attempts = 0;
    const check = setInterval(() => {
      if (!isRunning(pid)) {
        clearInterval(check);
        delete inst[key];
        if (Object.keys(inst).length === 0) {
          try {
            unlinkSync(INSTANCES_FILE);
          } catch {}
        } else {
          writeInstances(inst);
        }
        console.log("Server stopped.");
        resolve();
        return;
      }
      if (++attempts > 10) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        clearInterval(check);
        delete inst[key];
        if (Object.keys(inst).length === 0) {
          try {
            unlinkSync(INSTANCES_FILE);
          } catch {}
        } else {
          writeInstances(inst);
        }
        console.log("Server force-stopped.");
        resolve();
      }
    }, 500);
  });
}

function stopAll() {
  const inst = cleanInstances();
  if (Object.keys(inst).length === 0) {
    console.log("No servers running.");
    return Promise.resolve();
  }
  return Promise.all(
    Object.keys(inst).map((port) => stopOne(parseInt(port, 10))),
  );
}

function showList() {
  const inst = cleanInstances();
  const ports = Object.keys(inst);
  if (ports.length === 0) {
    console.log("No servers running.");
    return;
  }
  console.log("Running instances:");
  for (const [port, pid] of Object.entries(inst))
    console.log(`  Port ${port} — PID ${pid}`);
}

function showStatus() {
  const inst = cleanInstances();
  const ports = Object.keys(inst);
  if (ports.length === 0) {
    console.log("No servers running.");
    return;
  }
  if (ports.length === 1) {
    const port = ports[0];
    console.log(`Server is running on port ${port} (PID ${inst[port]}).`);
    printInfo(parseInt(port, 10));
  } else {
    showList();
  }
}

function showLogs() {
  if (!existsSync(LOG_FILE)) {
    console.log("No log file found.");
    return;
  }
  const tail = spawn("tail", ["-f", "-n", "50", LOG_FILE], {
    stdio: "inherit",
  });
  tail.on("close", () => process.exit(0));
}

function parseFlags(argv) {
  const result = { port: null, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") {
      result.port = parseInt(argv[++i], 10);
      if (!result.port || result.port < 1 || result.port > 65535) {
        console.error("Invalid port. Must be 1-65535.");
        process.exit(1);
      }
    } else if (a === "--all" || a === "-a") {
      result.all = true;
    }
  }
  return result;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help") {
    usage();
    return;
  }

  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));

  if (cmd === "build") {
    try {
      await build();
      console.log("Build complete.");
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  if (cmd === "list" || cmd === "ls") {
    showList();
    return;
  }
  if (cmd === "status" || cmd === "info") {
    showStatus();
    return;
  }
  if (cmd === "logs" || cmd === "log") {
    showLogs();
    return;
  }

  if (cmd === "stop" || cmd === "kill") {
    if (flags.all) {
      await stopAll();
    } else if (flags.port) {
      await stopOne(flags.port);
    } else {
      const inst = cleanInstances();
      const ports = Object.keys(inst);
      if (ports.length === 0) {
        console.log("No servers running.");
      } else if (ports.length === 1) {
        await stopOne(parseInt(ports[0], 10));
      } else {
        console.log("Multiple instances running. Use --port or --all:");
        showList();
        process.exit(1);
      }
    }
    return;
  }

  if (cmd === "restart") {
    const envPort = readPort();
    const inst = cleanInstances();
    if (inst[String(envPort)]) await stopOne(envPort);
    await ensureBuilt();
    await startServer(envPort);
    return;
  }

  if (cmd === "start") {
    const startPort = flags.port || readPort();
    await ensureBuilt();
    await startServer(startPort);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

main();

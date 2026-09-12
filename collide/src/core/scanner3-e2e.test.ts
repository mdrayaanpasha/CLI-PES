import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseLockfile } from "./lockfile";
import { runScans } from "./scanner";
import { allScanners, parseArgs, resolveEnabledScanners } from "../cli";
import { eventListenerScanner } from "../scanners/event-listeners";
import { formatReport } from "../report/format";
import { clearCache, getDb } from "../cache/db";
import type { Finding, ResolvedPackage } from "./types";

describe("Stage 15: Scanner 3 End-to-End Validation", () => {
  let projectDir: string;
  let lockfilePath: string;

  beforeEach(() => {
    clearCache();
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "collide-e2e-project-"));
    lockfilePath = path.join(projectDir, "package-lock.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(projectDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  /**
   * Helper to construct a realistic npm project structure with package.json,
   * package-lock.json, and node_modules/<package> directories.
   */
  function setupRealisticNpmProject() {
    const nodeModulesDir = path.join(projectDir, "node_modules");
    fs.mkdirSync(nodeModulesDir, { recursive: true });

    // 1. winston-telemetry @ 1.0.0
    // Registers uncaughtException and resize
    const winstonDir = path.join(nodeModulesDir, "winston-telemetry");
    fs.mkdirSync(winstonDir, { recursive: true });
    fs.writeFileSync(
      path.join(winstonDir, "package.json"),
      JSON.stringify({ name: "winston-telemetry", version: "1.0.0", main: "index.js" }),
    );
    fs.writeFileSync(
      path.join(winstonDir, "index.js"),
      `
process.on("uncaughtException", (err) => {
  console.error("Winston caught exception:", err);
});
window.addEventListener("resize", () => {
  console.log("Winston resize handler");
});
`,
    );

    // 2. sentry-agent @ 2.0.0
    // Registers uncaughtException via process alias, and resize
    const sentryDir = path.join(nodeModulesDir, "sentry-agent");
    fs.mkdirSync(sentryDir, { recursive: true });
    fs.writeFileSync(
      path.join(sentryDir, "package.json"),
      JSON.stringify({ name: "sentry-agent", version: "2.0.0", main: "lib/agent.js" }),
    );
    const sentryLib = path.join(sentryDir, "lib");
    fs.mkdirSync(sentryLib, { recursive: true });
    fs.writeFileSync(
      path.join(sentryLib, "agent.js"),
      `
const proc = process;
proc.addListener("uncaughtException", (err) => {
  sendToSentry(err);
});
window.addEventListener("resize", () => {
  trackViewport();
});
`,
    );

    // 3. hot-reloader @ 0.5.0
    // Registers SIGTERM (with prependListener) and benign DOMContentLoaded
    const reloaderDir = path.join(nodeModulesDir, "hot-reloader");
    fs.mkdirSync(reloaderDir, { recursive: true });
    fs.writeFileSync(
      path.join(reloaderDir, "package.json"),
      JSON.stringify({ name: "hot-reloader", version: "0.5.0", main: "index.js" }),
    );
    fs.writeFileSync(
      path.join(reloaderDir, "index.js"),
      `
process.prependListener("SIGTERM", () => {
  flushHotUpdates();
});
document.addEventListener("DOMContentLoaded", () => {
  initHmr();
});
`,
    );

    // 4. graceful-shutdown @ 1.2.0
    // Registers SIGTERM (normal on) and benign load
    const shutdownDir = path.join(nodeModulesDir, "graceful-shutdown");
    fs.mkdirSync(shutdownDir, { recursive: true });
    fs.writeFileSync(
      path.join(shutdownDir, "package.json"),
      JSON.stringify({ name: "graceful-shutdown", version: "1.2.0", main: "main.js" }),
    );
    fs.writeFileSync(
      path.join(shutdownDir, "main.js"),
      `
process.on("SIGTERM", () => {
  closeConnections();
});
window.addEventListener("load", () => {
  ready();
});
`,
    );

    // 5. local-queue @ 3.0.0
    // Registers local EventEmitter uncaughtException, dynamic event name, and DOM button
    const queueDir = path.join(nodeModulesDir, "local-queue");
    fs.mkdirSync(queueDir, { recursive: true });
    fs.writeFileSync(
      path.join(queueDir, "package.json"),
      JSON.stringify({ name: "local-queue", version: "3.0.0", main: "index.js" }),
    );
    fs.writeFileSync(
      path.join(queueDir, "index.js"),
      `
const EventEmitter = require("events");
const localQueueEmitter = new EventEmitter();
localQueueEmitter.on("uncaughtException", () => {});
process.on(config.dynamicEventName, () => {});
const btn = document.getElementById("queue-btn");
btn.addEventListener("click", () => {});
`,
    );

    // 6. isolated-worker @ 1.0.0
    // Registers process.exit and process.exit multiple times (same package duplicates, no collision)
    const workerDir = path.join(nodeModulesDir, "isolated-worker");
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(
      path.join(workerDir, "package.json"),
      JSON.stringify({ name: "isolated-worker", version: "1.0.0", main: "index.js" }),
    );
    fs.writeFileSync(
      path.join(workerDir, "index.js"),
      `
process.on("exit", () => cleanWorker());
process.once("exit", () => logExit());
`,
    );

    // Create npm package-lock.json (v3 format)
    const lockfileContent = {
      name: "realistic-e2e-app",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "realistic-e2e-app",
          version: "1.0.0",
        },
        "node_modules/winston-telemetry": {
          version: "1.0.0",
        },
        "node_modules/sentry-agent": {
          version: "2.0.0",
        },
        "node_modules/hot-reloader": {
          version: "0.5.0",
        },
        "node_modules/graceful-shutdown": {
          version: "1.2.0",
        },
        "node_modules/local-queue": {
          version: "3.0.0",
        },
        "node_modules/isolated-worker": {
          version: "1.0.0",
        },
      },
    };

    fs.writeFileSync(lockfilePath, JSON.stringify(lockfileContent, null, 2), "utf-8");
  }

  describe("End-to-End Package Discovery and Scanning Pipeline", () => {
    it("discovers packages from package-lock.json and resolves primary entrypoints accurately", () => {
      setupRealisticNpmProject();

      const packages = parseLockfile(lockfilePath);

      assert.equal(packages.length, 6);
      const pkgMap = new Map(packages.map((p) => [p.name, p]));

      assert.ok(pkgMap.has("winston-telemetry"));
      assert.equal(pkgMap.get("winston-telemetry")!.version, "1.0.0");
      assert.ok(pkgMap.get("winston-telemetry")!.sourcePath?.endsWith("index.js"));

      assert.ok(pkgMap.has("sentry-agent"));
      assert.equal(pkgMap.get("sentry-agent")!.version, "2.0.0");
      assert.ok(pkgMap.get("sentry-agent")!.sourcePath?.endsWith("lib/agent.js"));

      assert.ok(pkgMap.has("graceful-shutdown"));
      assert.equal(pkgMap.get("graceful-shutdown")!.version, "1.2.0");
      assert.ok(pkgMap.get("graceful-shutdown")!.sourcePath?.endsWith("main.js"));
    });

    it("executes the full pipeline and detects exact cross-package collisions with zero false positives", async () => {
      setupRealisticNpmProject();

      const packages = parseLockfile(lockfilePath);
      const findings = await runScans(packages, [eventListenerScanner]);

      // Expected Collisions:
      // 1. global_process:uncaughtException (sentry-agent, winston-telemetry) -> CRITICAL
      // 2. global_process:SIGTERM (graceful-shutdown, hot-reloader) -> CRITICAL (due to prependListener)
      // 3. global_window:resize (sentry-agent, winston-telemetry) -> MEDIUM
      //
      // Expected False Positives Filtered Out:
      // - local-queue (custom EventEmitter, dynamic event, DOM element)
      // - hot-reloader & graceful-shutdown benign DOMContentLoaded / load
      // - isolated-worker process.exit (single owner)

      assert.equal(findings.length, 3);

      const targets = findings.map((f) => f.target).sort();
      assert.deepEqual(targets, [
        "global_process:SIGTERM",
        "global_process:uncaughtException",
        "global_window:resize",
      ]);

      // 1. uncaughtException verification
      const uncaught = findings.find((f) => f.target === "global_process:uncaughtException")!;
      assert.equal(uncaught.scanner, "event-listeners");
      assert.equal(uncaught.severity, "critical");
      assert.deepEqual(uncaught.owners, ["sentry-agent", "winston-telemetry"]);
      assert.ok(uncaught.message.includes("sentry-agent@2.0.0"));
      assert.ok(uncaught.message.includes("winston-telemetry@1.0.0"));
      assert.ok(uncaught.message.includes("swallow unhandled errors"));

      // 2. SIGTERM verification (with prepend escalation)
      const sigterm = findings.find((f) => f.target === "global_process:SIGTERM")!;
      assert.equal(sigterm.scanner, "event-listeners");
      assert.equal(sigterm.severity, "critical"); // escalated from high
      assert.deepEqual(sigterm.owners, ["graceful-shutdown", "hot-reloader"]);
      assert.ok(sigterm.message.includes("Prepend registration is used"));

      // 3. resize verification
      const resize = findings.find((f) => f.target === "global_window:resize")!;
      assert.equal(resize.scanner, "event-listeners");
      assert.equal(resize.severity, "medium");
      assert.deepEqual(resize.owners, ["sentry-agent", "winston-telemetry"]);
      assert.ok(resize.message.includes("viewport listeners"));
    });
  });

  describe("End-to-End SQLite Cache Verification", () => {
    it("caches extracted AST profiles on first run and restores them on subsequent runs without re-parsing", async () => {
      setupRealisticNpmProject();
      const packages = parseLockfile(lockfilePath);

      // Run 1: First scan populates the cache
      const firstRunFindings = await runScans(packages, [eventListenerScanner]);
      assert.equal(firstRunFindings.length, 3);

      const db = getDb();
      const countRow = db.prepare("SELECT count(*) as cnt FROM ast_profiles").get() as { cnt: number };
      assert.equal(countRow.cnt, 6);

      // Mutate one of the source files on disk to garbage to verify second run reads strictly from cache
      const winstonSource = packages.find((p) => p.name === "winston-telemetry")!.sourcePath!;
      fs.writeFileSync(winstonSource, "INVALID SYNTAX {{{ &&& (((", "utf-8");

      // Run 2: Second scan must hit SQLite cache and return identical findings without re-parsing corrupted source
      const secondRunFindings = await runScans(packages, [eventListenerScanner]);
      assert.deepEqual(secondRunFindings, firstRunFindings);
    });
  });

  describe("CLI Integration and Output Formatting", () => {
    it("formats findings in readable table output format", async () => {
      setupRealisticNpmProject();
      const packages = parseLockfile(lockfilePath);
      const findings = await runScans(packages, [eventListenerScanner]);

      const table = formatReport(findings, "table");

      assert.ok(table.includes("[CRITICAL] event-listeners: global_process:uncaughtException —"));
      assert.ok(table.includes("[CRITICAL] event-listeners: global_process:SIGTERM —"));
      assert.ok(table.includes("[MEDIUM] event-listeners: global_window:resize —"));
      assert.ok(table.includes("sentry-agent"));
      assert.ok(table.includes("winston-telemetry"));
    });

    it("formats findings in valid structured JSON format for MCP/tools", async () => {
      setupRealisticNpmProject();
      const packages = parseLockfile(lockfilePath);
      const findings = await runScans(packages, [eventListenerScanner]);

      const jsonStr = formatReport(findings, "json");
      const parsed = JSON.parse(jsonStr) as Finding[];

      assert.equal(Array.isArray(parsed), true);
      assert.equal(parsed.length, 3);

      for (const item of parsed) {
        assert.equal(item.scanner, "event-listeners");
        assert.ok(["low", "medium", "high", "critical"].includes(item.severity));
        assert.ok(typeof item.target === "string");
        assert.ok(Array.isArray(item.owners) && item.owners.length >= 2);
        assert.ok(typeof item.message === "string" && item.message.length > 0);
      }
    });

    it("respects CLI args --only=event-listeners and lockfile path", async () => {
      setupRealisticNpmProject();
      const cliArgs = parseArgs(["node", "collide", "scan", lockfilePath, "--only=event-listeners", "--format=json"]);

      assert.equal(cliArgs.lockfilePath, lockfilePath);
      assert.deepEqual(cliArgs.only, ["event-listeners"]);
      assert.equal(cliArgs.format, "json");

      const enabledScanners = resolveEnabledScanners(cliArgs.only, allScanners);
      assert.equal(enabledScanners.length, 1);
      assert.equal(enabledScanners[0].name, "event-listeners");

      const packages = parseLockfile(cliArgs.lockfilePath);
      const findings = await runScans(packages, enabledScanners);

      assert.equal(findings.length, 3);
      const output = formatReport(findings, cliArgs.format);
      const parsed = JSON.parse(output);
      assert.equal(parsed.length, 3);
    });
  });
});
